/**
 * Aquila → finnyEMR Migration Tool
 *
 * Usage:
 *   node aquila-migrator.js \
 *     --url https://springmed.aquila.ng \
 *     --user springmed \
 *     --pass springmed \
 *     --finny-url https://your-finnyemr.com \
 *     --finny-token YOUR_API_TOKEN \
 *     --tenant-id YOUR_TENANT_UUID \
 *     --out ./migration-output \
 *     [--dry-run]        # extract only, don't push to finnyEMR
 *     [--skip-extract]   # skip extraction, use existing ./migration-output/raw
 *     [--batch-size 50]  # patients per batch (default 50)
 *
 * What it does:
 *   Phase 1 — Extract: pulls all patients + encounters + labs from Aquila
 *   Phase 2 — Transform: maps Aquila schema → finnyEMR schema
 *   Phase 3 — Load: POSTs to finnyEMR API (skipped with --dry-run)
 *   Reports: writes migration-report.json summarising success/failure per record
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

// ─── CLI args ───────────────────────────────────────────────────────────────

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  return process.argv[i + 1] ?? true;
}

const AQUILA_URL   = arg('url',          'https://springmed.aquila.ng');
const AQUILA_USER  = arg('user',         'springmed');
const AQUILA_PASS  = arg('pass',         'springmed');
const FINNY_URL    = arg('finny-url',    null);
const FINNY_TOKEN  = arg('finny-token',  null);
const FINNY_USER   = arg('finny-user',   null);
const FINNY_PASS   = arg('finny-pass',   null);
const FINNY_ORIGIN = arg('finny-origin', 'http://localhost:3000');
const TENANT_ID    = arg('tenant-id',    null);
const OUT_DIR      = arg('out',          './migration-output');
const DRY_RUN      = arg('dry-run',      false) !== false;
const SKIP_EXTRACT = arg('skip-extract', false) !== false;
const BATCH_SIZE   = parseInt(arg('batch-size', '50'), 10);
const LIMIT        = parseInt(arg('limit', '0'), 10); // 0 = no limit (all patients)
const RETRY_FAILED = arg('retry-failed', false) !== false; // only load previously failed patients

// Lab document types Aquila uses
const LAB_TYPES = new Set([
  'pcv','wbc','fbc_2','esr','dwcc','urinalysis','mal_parasite','mcf_parasite',
  'hiv_screening','blood_group','h_pilori','hbsag','hep_c','blood_pt','urine_pt',
  'microscopy','clinic_chem_path','widal','hb_genotype','haemoglobin','cul_sens',
  'vdrl','aso_titre','zhiel_nelson_afb','mcv','stool_microscopy','acid_phospha',
  'rbs','lft','urea_e','thyroid','psa','hormones','semen_analysis',
]);

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function request(baseUrl, endpoint, params, cookies = '') {
  return new Promise((resolve, reject) => {
    const body   = new URLSearchParams(params).toString();
    const parsed = new URL(baseUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib    = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     '/' + endpoint,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Cookie':         cookies,
        'User-Agent':     'finnyEMR-migrator/1.0',
      },
      rejectUnauthorized: false,
    };

    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'] || [];
        let parsed;
        const trimmed = data.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { parsed = JSON.parse(trimmed); } catch { parsed = { raw: data }; }
        } else {
          parsed = { raw: data };
        }
        resolve({ body: parsed, cookies: setCookie, status: res.statusCode });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { retries = 4, baseDelay = 2000, label = '' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED'
        || err.code === 'ETIMEDOUT' || err.message === 'socket hang up'
        || err.message === 'timeout';
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
      process.stdout.write(`\n   ⚠ ${label} failed (${err.message}), retry ${attempt + 1}/${retries} in ${delay / 1000}s...\r`);
      await sleep(delay);
    }
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ─── Aquila client ───────────────────────────────────────────────────────────

class AquilaClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = '';
  }

  async post(endpoint, params) {
    const res = await withRetry(
      () => request(this.baseUrl, endpoint, params, this.cookies),
      { label: `Aquila ${endpoint}` }
    );
    // Accumulate session cookies
    if (res.cookies.length) {
      const jar = {};
      this.cookies.split(';').forEach(c => {
        const [k, v] = c.trim().split('=');
        if (k) jar[k.trim()] = v;
      });
      res.cookies.forEach(c => {
        const [kv] = c.split(';');
        const [k, v] = kv.split('=');
        if (k) jar[k.trim()] = v || '';
      });
      this.cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return res.body;
  }

  async login(user, pass) {
    const res = await this.post('authentication', {
      medman_command_name: 'login',
      '--userName': user,
      '--password': pass,
    });
    if (res?.result !== 'success') throw new Error('Aquila login failed: ' + JSON.stringify(res));
    // Sign into facility office 1
    await this.post('staffoffice', {
      medman_command_name: 'office-sign-in',
      officeId: 1,
      startShift: false,
    });
    console.log('✓ Logged in to Aquila');
    return res;
  }

  async getTotalPatientCount(facilityId = 1) {
    const res = await this.post('patients', {
      medman_command_name: 'get-per-facility-unlimited-patient-count',
    });
    return res?.response?.[facilityId] ?? res?.response?.['1'] ?? 0;
  }

  async getPatientPage(facilityId = 1, start = 0, length = 50) {
    const res = await this.post('patients', {
      facilityId,
      term: '',
      start,
      length,
      sortColumn: 'id_param',
      isAsc: false,
      medman_command_name: 'patient-search-auto',
    });
    return res?.response?.data ?? [];
  }

  async getPatientDocument(docPath) {
    const res = await this.post('patient', {
      id: docPath,
      medman_command_name: 'get-document',
    });
    if (res?.result !== 'success') return null;
    const data = res?.response?.data;
    if (!data) return null;
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return data; }
    }
    return data;
  }

  async getPatientDocuments(docPaths) {
    // Batch fetch multiple docs at once
    const res = await this.post('patient', {
      id: JSON.stringify(docPaths),
      medman_command_name: 'get-document',
    });
    if (res?.result !== 'success') return [];
    const rows = res?.response?.data ?? res?.response ?? [];
    return Array.isArray(rows) ? rows : [];
  }

  async openPatientFolder(patientId) {
    const res = await this.post('patient', {
      id: patientId,
      medman_command_name: 'open-patient-folder',
    });
    return res?.response?.data ?? [];
  }

  async getPatientFolderName(patientId) {
    const res = await this.post('patient', {
      id: patientId,
      medman_command_name: 'get-patient-folder-name',
    });
    return res?.response ?? null;
  }

  async listEncounterDocuments(encounterFolderPath) {
    const res = await this.post('patient', {
      folder_fullpath: encounterFolderPath,
      medman_command_name: 'list-folder-documents',
    });
    return res?.response ?? [];
  }

  async getDocumentContent(fullname) {
    const res = await this.post('patient', {
      id: fullname,
      medman_command_name: 'get-document',
    });
    if (res?.result !== 'success') return null;
    const data = res?.response?.data;
    if (!data) return null;
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return data; }
    }
    return data;
  }

  async getEncounterList(patientId) {
    // Aquila stores encounters as subfolders of the patient EMR folder
    const folders = await this.openPatientFolder(patientId);
    return folders.filter(f => f.type === 'visit_info' || (f.format === 'FOLDER' && f.name !== 'patient_info'));
  }
}

// ─── Phase 1: Extract ────────────────────────────────────────────────────────

async function extractAll(client, outDir) {
  const rawDir = path.join(outDir, 'raw');
  ensureDir(rawDir);

  console.log('\n📥 Phase 1: Extracting from Aquila...');

  const total = await client.getTotalPatientCount();
  const fetchLimit = LIMIT > 0 ? Math.min(LIMIT, total) : total;
  console.log(`   Total patients in Aquila: ${total}${LIMIT > 0 ? ` (limiting to ${fetchLimit})` : ''}`);

  // Resume: reload a partial index if the previous run saved one
  const indexPath = path.join(rawDir, 'patients-index.json');
  const allPatients = fs.existsSync(indexPath) ? readJson(indexPath) : [];
  let start = allPatients.length; // resume from where we left off

  if (start > 0) {
    console.log(`   Resuming index from ${start} already fetched...`);
  }

  while (start < fetchLimit) {
    const pageSize = Math.min(BATCH_SIZE, fetchLimit - start);
    process.stdout.write(`   Fetching patient list ${start}–${start + pageSize}/${fetchLimit}...\r`);
    const page = await withRetry(
      () => client.getPatientPage(1, start, pageSize),
      { label: `patient list page ${start}` }
    );
    if (!page.length) break;
    allPatients.push(...page);
    start += pageSize;
    // Save index after every page so a crash can resume
    writeJson(indexPath, allPatients);
    await sleep(400);
  }

  console.log(`\n   Got ${allPatients.length} patients`);

  const report = { total: allPatients.length, extracted: 0, skipped: 0, failed: [] };

  for (let i = 0; i < allPatients.length; i++) {
    const p = allPatients[i];
    const filePath = path.join(rawDir, `patient-${p.id}.json`);

    // Resume: skip patients already extracted in a previous run
    if (fs.existsSync(filePath)) {
      report.skipped++;
      report.extracted++;
      continue;
    }

    process.stdout.write(`   Extracting patient ${i + 1}/${allPatients.length} (id=${p.id})...\r`);

    try {
      const patientData = await withRetry(
        () => extractPatient(client, p),
        { label: `patient ${p.id}` }
      );
      writeJson(filePath, patientData);
      report.extracted++;
    } catch (err) {
      report.failed.push({ id: p.id, error: err.message });
    }

    await sleep(250);
  }

  writeJson(path.join(rawDir, 'extract-report.json'), report);
  console.log(`\n   Extracted: ${report.extracted}/${report.total} (${report.skipped} resumed), Failed: ${report.failed.length}`);
  return report;
}

async function extractPatient(client, patientStub) {
  const folderName = patientStub.folderName; // e.g. "EMR/1794473675942"

  // Fetch personal info, health history, billing info, next of kin in one batch
  const docPaths = [
    `${folderName}/patient_info/personal_info`,
    `${folderName}/patient_info/health_history`,
    `${folderName}/patient_info/billing_info`,
    `${folderName}/patient_info/next_of_kin`,
  ];

  const docRows = await client.getPatientDocuments(docPaths);
  const docs = {};
  for (const row of docRows) {
    if (row?.response?.data) {
      const key = row?.response?.documentHeader?.attributeMap?.NAME ?? row?.name ?? 'unknown';
      let d = row.response.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
      docs[key] = d;
    }
  }

  // If batch fetch returned nothing (Aquila sometimes needs individual fetches)
  if (!docs.personal_info) {
    const pi = await client.getPatientDocument(`${folderName}/patient_info/personal_info`);
    if (pi) docs.personal_info = pi;
  }
  if (!docs.billing_info) {
    const bi = await client.getPatientDocument(`${folderName}/patient_info/billing_info`);
    if (bi) docs.billing_info = bi;
  }

  // Get encounters (subfolders of patient EMR folder)
  const folderContents = await client.openPatientFolder(patientStub.id);
  const encounterFolders = folderContents.filter(f =>
    f.format === 'FOLDER' && f.name !== 'patient_info'
  );

  const encounters = [];
  for (const ef of encounterFolders) {
    try {
      const enc = await extractEncounter(client, ef.fullname ?? ef.folder_full_name + '/' + ef.name);
      if (enc) encounters.push(enc);
      await sleep(100);
    } catch {
      // skip failed encounter
    }
  }

  return {
    stub:      patientStub,
    docs,
    encounters,
    extractedAt: new Date().toISOString(),
  };
}

async function extractEncounter(client, encounterFolderPath) {
  const docs = await client.listEncounterDocuments(encounterFolderPath);
  if (!docs.length) return null;

  const properties = docs.find(d => d.name === '.properties');
  const clinicalDocs = docs.filter(d => d.name !== '.properties' && !d.hidden);

  const contents = {};
  for (const doc of clinicalDocs) {
    try {
      const content = await client.getDocumentContent(doc.fullname);
      if (content) {
        contents[doc.type ?? doc.name] = { meta: doc, data: content };
      }
      await sleep(80);
    } catch {
      // skip
    }
  }

  return {
    folderPath: encounterFolderPath,
    properties: properties ?? null,
    documents:  contents,
  };
}

// ─── Phase 2: Transform ──────────────────────────────────────────────────────

// Normalize Aquila gender to finnyEMR's AdministrativeGender enum
function normalizeGender(raw) {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'male' || v === 'm') return 'male';
  if (v === 'female' || v === 'f') return 'female';
  if (v === 'other') return 'other';
  return 'unknown';
}

// Format an ISO date string as YYYY-MM-DD (finnyEMR only wants dates, not datetimes)
function isoDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Strip HTML tags and decode basic entities
function stripHtml(str) {
  if (!str) return null;
  if (typeof str !== 'string') return null;
  return str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

// Render a value that may be an object/array into a readable string
function renderValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return stripHtml(val);
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return val.map(renderValue).filter(Boolean).join(', ');
  if (typeof val === 'object') {
    return Object.entries(val)
      .map(([k, v]) => `${k}: ${renderValue(v)}`)
      .filter(Boolean)
      .join(', ');
  }
  return String(val);
}

// Normalize Nigerian phone number to 11-digit format starting with 0
function normalizePhone(raw) {
  if (!raw) return null;
  // Keep only digits
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Already starts with 0 and is 11 digits — perfect
  if (digits.startsWith('0') && digits.length === 11) return digits;
  // 10-digit number without leading 0 (e.g. 8056312822) — prepend 0
  if (!digits.startsWith('0') && digits.length === 10) return '0' + digits;
  // Longer: take first 10 non-zero-leading digits and prepend 0
  if (digits.length > 11) {
    const core = digits.startsWith('0') ? digits.slice(1, 11) : digits.slice(0, 10);
    return '0' + core;
  }
  // Shorter or already correct — return as-is, truncate to 20 chars max
  return digits.slice(0, 20);
}

// Expand a lab data object into individual component rows for finnyEMR
function expandLabComponents(testType, data, recordedAt) {
  if (!data || typeof data !== 'object') {
    // Scalar or string value
    const text = data ? String(data) : null;
    if (!text) return [];
    return [{ component_name: testType, value_text: text.substring(0, 255), resulted_at: recordedAt }];
  }

  const rows = [];
  for (const [key, val] of Object.entries(data)) {
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      // Nested object (e.g. diff: { neutrophils, lymphocytes }) — flatten one level
      for (const [subKey, subVal] of Object.entries(val)) {
        const name = `${testType} - ${key} - ${subKey}`;
        const numVal = parseFloat(subVal);
        rows.push({
          component_name: name,
          value_quantity:  isNaN(numVal) ? null : numVal,
          value_text:      isNaN(numVal) ? String(subVal).substring(0, 255) : null,
          resulted_at:     recordedAt,
        });
      }
    } else {
      const name = `${testType} - ${key}`;
      const numVal = parseFloat(val);
      rows.push({
        component_name: name,
        value_quantity:  isNaN(numVal) ? null : numVal,
        value_text:      isNaN(numVal) ? String(val).substring(0, 255) : null,
        resulted_at:     recordedAt,
      });
    }
  }
  return rows;
}

function transformPatient(raw, tenantId) {
  const stub  = raw.stub;
  const pi    = raw.docs?.personal_info?.patient  ?? {};
  const ci    = raw.docs?.personal_info?.contact  ?? {};
  const nok   = raw.docs?.next_of_kin             ?? {};

  // Build address array — finnyEMR expects { line1, line2, lga_code, postal_code, country }
  const addressLine = ci.address ?? null;
  const addressObj  = addressLine
    ? {
        line1:       addressLine,
        line2:       null,
        lga_code:    ci.lga        ?? ci.lga_code  ?? null,
        postal_code: ci.postal     ?? null,
        country:     ci.country    ?? 'Nigeria',
      }
    : null;

  // Build contacts array for next-of-kin
  const contacts = [];
  if (nok.name || nok.phone) {
    contacts.push({
      relationship: nok.relationship ?? 'next_of_kin',
      name:         nok.name         ?? 'Unknown',
      phone:        nok.phone        ?? null,
      email:        nok.email        ?? null,
      nin:          nok.nin          ?? null,
    });
  }

  return {
    // FHIR-aligned field names (RegisterPatientRequest schema)
    family_name:   pi.surname    ?? stub.surname    ?? stub.lastName  ?? '',
    given_name:    pi.firstName  ?? stub.firstName  ?? 'Unknown from Aquila',
    middle_name:   pi.otherName  ?? stub.otherName  ?? null,
    gender:        normalizeGender(pi.gender ?? stub.gender),
    // 1900-01-01 as sentinel for missing DOB — staff can update later
    date_of_birth: isoDate(pi.dob ?? stub.dateOfBirth) ?? '1900-01-01',

    // Contact — normalize phone to 11-digit Nigerian format
    phone:        normalizePhone(ci.phone1),
    email:        ci.email   ?? null,
    address:      addressObj,

    // Emergency/NOK as contacts array
    contacts:     contacts.length ? contacts : null,
  };
}

function transformEncounters(raw) {
  const result = [];

  for (const enc of (raw.encounters ?? [])) {
    const visitInfo = enc.properties;

    // Clinical consultation doc
    const consultTypes = ['fluid_consultation:2', 'fluid_consultation', 'doctors_review', 'consultation'];
    let consult = null;
    for (const t of consultTypes) {
      if (enc.documents[t]) { consult = enc.documents[t].data; break; }
    }

    // Vitals
    const vitalsRaw = enc.documents['vital_signs:2'] ?? enc.documents['vital_signs'];
    const vitals = vitalsRaw?.data ?? null;

    // Labs — any document whose type is in LAB_TYPES
    // Expand each lab doc into per-component rows so finnyEMR gets clean values
    const labs = [];
    for (const [type, doc] of Object.entries(enc.documents)) {
      const baseType = type.split(':')[0];
      if (LAB_TYPES.has(baseType)) {
        const recordedAt = isoDate(doc.meta?.date);
        const components = expandLabComponents(baseType, doc.data, recordedAt);
        labs.push(...components.map(c => ({ ...c, _test_type: baseType, _aquila_type: type })));
      }
    }

    // Build diagnoses array — finnyEMR requires `display` per diagnosis
    const diagnoses = [];
    if (consult?.diagnosis?.diagnosis) {
      for (const d of consult.diagnosis.diagnosis) {
        const text = d.value ?? d.display ?? d.name ?? null;
        if (text) diagnoses.push({ display: text.trim(), code: d.code ?? null });
      }
    } else if (typeof consult?.diagnosis === 'string' && consult.diagnosis.trim()) {
      diagnoses.push({ display: consult.diagnosis.trim() });
    }

    // period_start from Aquila encounter date (millisecond timestamp in folder path as fallback)
    const encTimestamp = enc.folderPath?.match(/\/(\d{13})/)?.[1];
    const periodStart = isoDate(visitInfo?.date)
      ?? (encTimestamp ? isoDate(new Date(parseInt(encTimestamp)).toISOString()) : null)
      ?? new Date().toISOString().slice(0, 10);

    // Vitals recorded_at — use the encounter date, not today
    const vitalsRecordedAt = isoDate(visitInfo?.date) ?? periodStart;

    // Chief complaint — fluid_consultation (array) vs doctors_review (flat string)
    let chiefComplaint = null;
    if (consult?.subjective?.complaints?.length) {
      chiefComplaint = consult.subjective.complaints.map(c => c.complaint).filter(Boolean).join('; ');
    } else if (typeof consult?.complaints === 'string' && consult.complaints.trim()) {
      chiefComplaint = consult.complaints.trim();
    } else if (consult?.subjective?.notes) {
      chiefComplaint = stripHtml(consult.subjective.notes);
    }

    // Clinical notes — history/subjective (strip HTML)
    const clinicalNotes = stripHtml(consult?.subjective?.notes)
      ?? (consult?.progress ? stripHtml(consult.progress) : null);

    // Examination — physical_exam + systems_review/systems_exam (strip HTML, render objects)
    const examParts = [
      renderValue(consult?.physical_exam),
      renderValue(consult?.systems_review),
      renderValue(consult?.systems_exam),
    ].filter(Boolean);

    // Treatment plan — strip HTML, handle both object and string forms
    const treatmentPlan = stripHtml(consult?.plan?.action)
      ?? (typeof consult?.plan === 'string' ? stripHtml(consult.plan) : null);

    result.push({
      _source_encounter_id: enc.folderPath,

      // RecordEncounterRequest fields
      encounter_type:  'outpatient',
      period_start:    periodStart,
      period_end:      isoDate(visitInfo?.last_modified) ?? null,
      chief_complaint: chiefComplaint,
      clinical_notes:  clinicalNotes,
      examination:     examParts.length ? examParts.join('\n\n') : null,
      treatment_plan:  treatmentPlan,
      diagnoses:       diagnoses.length ? diagnoses : null,

      _vitals: vitals ? {
        recorded_at:               vitalsRecordedAt,
        temperature_celsius:       parseFloat(vitals.temp        ?? vitals.temperature)       || null,
        blood_pressure_systolic:   parseInt(vitals.sbp           ?? vitals.bp_systolic  ?? vitals.systolic)   || null,
        blood_pressure_diastolic:  parseInt(vitals.dbp           ?? vitals.bp_diastolic ?? vitals.diastolic)  || null,
        pulse_bpm:                 parseInt(vitals.pulse         ?? vitals.pr)                || null,
        respiratory_rate:          parseInt(vitals.rr            ?? vitals.respiratory_rate)  || null,
        spo2_percent:              parseInt(vitals.sp02          ?? vitals.spo2)              || null,
        weight_kg:                 parseFloat(vitals.weight)                                  || null,
        height_cm:                 parseFloat(vitals.height)                                  || null,
      } : null,

      _labs: labs,

      _prescriptions: consult?.plan?.prescription
        ? consult.plan.prescription.map(rx => {
            const drug = parseJson(rx.drug) ?? {};
            const name = drug.name ?? (typeof rx.drug === 'string' ? rx.drug : null);
            if (!name) return null;
            return {
              medication_name: name,
              dosage_text:     [rx.dosage, rx.frequency, rx.duration].filter(Boolean).join(', ') || 'As directed',
              frequency:       rx.frequency ?? null,
              duration_days:   parseInt(rx.duration) || null,
            };
          }).filter(Boolean)
        : (typeof consult?.plan === 'string' && consult.plan.trim())
          ? [{ medication_name: 'Treatment plan (from Aquila)', dosage_text: consult.plan.trim().substring(0, 500) }]
          : [],
    });
  }

  return result;
}

function parseJson(str) {
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return null; }
}

// ─── Phase 3: Load (push to finnyEMR) ───────────────────────────────────────

class FinnyClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.token   = null;
    this.cookies = '';
  }

  async _req(method, path, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const payload  = body ? JSON.stringify(body) : null;
      const parsed   = new URL(this.baseUrl);
      const isHttps  = parsed.protocol === 'https:';
      const lib      = isHttps ? https : http;

      const headers = {
        'Accept':       'application/json',
        'Cookie':       this.cookies,
        'Origin':       FINNY_ORIGIN,
        'Referer':      FINNY_ORIGIN + '/',
        ...extraHeaders,
      };
      if (payload) {
        headers['Content-Type']   = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path,
        method,
        headers,
        rejectUnauthorized: false,
      };

      const req = lib.request(options, res => {
        let data = '';
        // Accumulate cookies
        (res.headers['set-cookie'] ?? []).forEach(c => {
          const [kv] = c.split(';');
          const [k, v] = kv.split('=');
          if (k) {
            const jar = {};
            this.cookies.split(';').filter(Boolean).forEach(ck => {
              const [ck_, cv_] = ck.trim().split('=');
              jar[ck_] = cv_;
            });
            jar[k.trim()] = v ?? '';
            this.cookies = Object.entries(jar).map(([a,b]) => `${a}=${b}`).join('; ');
          }
        });
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  _xsrfToken() {
    // Extract XSRF-TOKEN from cookie jar and URL-decode it
    const match = this.cookies.match(/XSRF-TOKEN=([^;]+)/);
    if (!match) return '';
    return decodeURIComponent(match[1]);
  }

  async login(email, password) {
    // Step 1: get CSRF cookie (seeds XSRF-TOKEN + session cookie)
    await this._req('GET', '/sanctum/csrf-cookie', null);

    // Step 2: Fortify login — session cookie is all we need going forward
    const res = await this._req('POST', '/api/v1/auth/login',
      { email, password, rememberMe: false },
      { 'X-XSRF-TOKEN': this._xsrfToken() }
    );

    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`finnyEMR login failed (${res.status}): ${JSON.stringify(res.body).substring(0, 200)}`);
    }

    console.log('✓ Logged in to finnyEMR');
  }

  async post(path, body) {
    return this._req('POST', path, body, { 'X-XSRF-TOKEN': this._xsrfToken() });
  }
}

async function finnyPost(url, token, path, body) {
  // Legacy wrapper — now uses FinnyClient internally when called from loadAll
  const client = new FinnyClient(url);
  client.token = token;
  return client.post(path, body);
}

async function loadAll(outDir, finnyUrl, finnyUser, finnyPass, finnyToken, tenantId) {
  console.log('\n📤 Phase 3: Loading into finnyEMR...');

  // Authenticate
  const finny = new FinnyClient(finnyUrl);
  if (finnyUser && finnyPass) {
    await finny.login(finnyUser, finnyPass);
  } else if (finnyToken) {
    finny.token = finnyToken;
    console.log('✓ Using provided API token');
  } else {
    throw new Error('Provide --finny-user/--finny-pass or --finny-token');
  }

  const rawDir  = path.join(outDir, 'raw');
  let index   = readJson(path.join(rawDir, 'patients-index.json'));

  // --retry-failed: filter index to only previously failed patients
  if (RETRY_FAILED) {
    const failedPath = path.join(outDir, 'failed-index.json');
    if (!fs.existsSync(failedPath)) throw new Error('--retry-failed requires failed-index.json in --out dir');
    const failedIds = new Set(readJson(failedPath).map(String));
    index = index.filter(s => failedIds.has(String(s.id)));
    console.log(`   Retrying ${index.length} previously failed patients...`);
  }

  const report  = { patients: { ok: 0, failed: [] }, encounters: { ok: 0, failed: [] }, prescriptions: { ok: 0, failed: [] }, labs: { ok: 0, failed: [] } };
  const patientIdMap = {};

  for (const stub of index) {
    const filePath = path.join(rawDir, `patient-${stub.id}.json`);
    if (!fs.existsSync(filePath)) continue;

    const raw = readJson(filePath);
    const patientPayload = transformPatient(raw, tenantId);

    // POST patient
    try {
      const res = await finny.post('/api/v1/patients', patientPayload);
      if (res.status === 201 || res.status === 200) {
        const finnyId = res.body?.data?.id ?? res.body?.id;
        patientIdMap[stub.id] = finnyId;
        report.patients.ok++;
      } else {
        report.patients.failed.push({ sourceId: stub.id, status: res.status, body: res.body });
      }
    } catch (err) {
      report.patients.failed.push({ sourceId: stub.id, error: err.message });
    }

    const encounters = transformEncounters(raw);
    const finnyPatientId = patientIdMap[stub.id];

    for (const enc of encounters) {
      const sourceId = enc._source_encounter_id;

      if (!finnyPatientId) {
        report.encounters.failed.push({ reason: 'no_finny_patient_id', sourceEncounter: sourceId });
        continue;
      }

      // Strip internal tracking fields before POSTing
      const encPayload = { ...enc };
      const vitalsPayload       = encPayload._vitals;
      const labsPayload         = encPayload._labs;
      const prescriptionsPayload = encPayload._prescriptions;
      delete encPayload._source_encounter_id;
      delete encPayload._vitals;
      delete encPayload._labs;
      delete encPayload._prescriptions;

      try {
        const res = await finny.post(`/api/v1/patients/${finnyPatientId}/encounters`, encPayload);
        if (res.status === 201 || res.status === 200) {
          const encId = res.body?.data?.id ?? res.body?.id;
          report.encounters.ok++;

          // Post vitals
          if (vitalsPayload && encId) {
            try {
              const vres = await finny.post(`/api/v1/encounters/${encId}/vitals`, vitalsPayload);
              if (vres.status !== 201 && vres.status !== 200) {
                report.encounters.failed.push({ sourceEncounter: sourceId, reason: 'vitals_failed', status: vres.status, body: vres.body });
              }
            } catch (err) {
              report.encounters.failed.push({ sourceEncounter: sourceId, reason: 'vitals_error', error: err.message });
            }
            await sleep(50);
          }

          // Post prescriptions
          for (const rx of (prescriptionsPayload ?? [])) {
            try {
              const pres = await finny.post(`/api/v1/encounters/${encId}/prescriptions`, rx);
              if (pres.status === 201 || pres.status === 200) report.prescriptions.ok++;
              else report.prescriptions.failed.push({ sourceEncounter: sourceId, status: pres.status, body: pres.body });
            } catch (err) {
              report.prescriptions.failed.push({ sourceEncounter: sourceId, error: err.message });
            }
            await sleep(50);
          }

          // Post lab orders + results
          // _labs is now pre-expanded: each entry is one component row tagged with _test_type/_aquila_type
          // Group components by test type → one order per test, multiple results per order
          const labsByType = {};
          for (const comp of (labsPayload ?? [])) {
            const key = comp._test_type ?? comp.component_name;
            if (!labsByType[key]) labsByType[key] = { aquilaType: comp._aquila_type, components: [] };
            labsByType[key].components.push(comp);
          }

          for (const [testType, { aquilaType, components }] of Object.entries(labsByType)) {
            try {
              // Step 1: create one lab order per test type
              const firstComp = components[0];
              const orderPayload = {
                test_name:  testType,
                ordered_at: firstComp.resulted_at ?? encPayload.period_start,
              };
              const ores = await finny.post(`/api/v1/encounters/${encId}/lab-orders`, orderPayload);
              if (ores.status !== 201 && ores.status !== 200) {
                report.labs.failed.push({ sourceEncounter: sourceId, testType, reason: 'order_failed', status: ores.status });
                continue;
              }
              const orderId = ores.body?.data?.id ?? ores.body?.id;
              await sleep(50);

              // Step 2: post each component as a separate result row
              for (const comp of components) {
                const { _test_type, _aquila_type, ...resultPayload } = comp;
                const rres = await finny.post(`/api/v1/lab-orders/${orderId}/results`, resultPayload);
                if (rres.status === 201 || rres.status === 200) report.labs.ok++;
                else report.labs.failed.push({ sourceEncounter: sourceId, testType, reason: 'result_failed', status: rres.status, body: rres.body });
                await sleep(30);
              }
            } catch (err) {
              report.labs.failed.push({ sourceEncounter: sourceId, testType, error: err.message });
            }
            await sleep(80);
          }
        } else {
          report.encounters.failed.push({ sourceEncounter: sourceId, status: res.status, body: res.body });
        }
      } catch (err) {
        report.encounters.failed.push({ sourceEncounter: sourceId, error: err.message });
      }

      await sleep(100);
    }

    await sleep(150);
    process.stdout.write(`   Loaded patient ${stub.id} → ${patientIdMap[stub.id] ?? 'FAILED'}\r`);
  }

  writeJson(path.join(outDir, 'patient-id-map.json'), patientIdMap);
  writeJson(path.join(outDir, 'load-report.json'), report);

  console.log(`\n   Patients loaded:      ${report.patients.ok} ✓  ${report.patients.failed.length} ✗`);
  console.log(`   Encounters loaded:    ${report.encounters.ok} ✓  ${report.encounters.failed.length} ✗`);
  console.log(`   Prescriptions loaded: ${report.prescriptions.ok} ✓  ${report.prescriptions.failed.length} ✗`);
  console.log(`   Lab results loaded:   ${report.labs.ok} ✓  ${report.labs.failed.length} ✗`);
  return report;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(OUT_DIR);

  console.log('═══════════════════════════════════════════');
  console.log('  Aquila → finnyEMR Migration Tool');
  console.log('═══════════════════════════════════════════');
  console.log(`  Source:   ${AQUILA_URL}`);
  console.log(`  Dest:     ${FINNY_URL ?? '(dry-run, no push)'}`);
  console.log(`  Auth:     ${FINNY_USER ? FINNY_USER : (FINNY_TOKEN ? 'token' : '(dry-run)')}`);
  console.log(`  Tenant:   ${TENANT_ID ?? '(dry-run)'}`);
  console.log(`  Dry run:  ${DRY_RUN}`);
  console.log(`  Output:   ${OUT_DIR}`);
  console.log('───────────────────────────────────────────\n');

  if (!SKIP_EXTRACT) {
    const client = new AquilaClient(AQUILA_URL);
    await client.login(AQUILA_USER, AQUILA_PASS);
    await extractAll(client, OUT_DIR);
  } else {
    console.log('⏭  Skipping extraction (--skip-extract)');
  }

  if (DRY_RUN) {
    console.log('\n✅ Dry-run complete. Raw data in', path.join(OUT_DIR, 'raw'));
    console.log('   Review it, then run without --dry-run to push to finnyEMR.');
    return;
  }

  if (!FINNY_URL || !TENANT_ID) {
    console.error('\n⚠️  --finny-url and --tenant-id are required to load data.');
    console.error('   Also provide --finny-user + --finny-pass, or --finny-token.');
    console.error('   Run with --dry-run to extract only.');
    process.exit(1);
  }

  await loadAll(OUT_DIR, FINNY_URL, FINNY_USER, FINNY_PASS, FINNY_TOKEN, TENANT_ID);

  console.log('\n✅ Migration complete. Reports in', OUT_DIR);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
