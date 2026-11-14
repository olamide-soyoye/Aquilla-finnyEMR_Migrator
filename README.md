# Aquila → finnyEMR Migrator

Migrates patient records, encounters, vitals, prescriptions, and lab results from an Aquila EMR instance (Imacious Data Technologies) into finnyEMR.

## Prerequisites

- Node.js v18+
- Access to the Aquila instance (URL + login credentials)
- A running finnyEMR backend
- A finnyEMR facility admin account and tenant ID

## Usage

### Full migration (extract from Aquila + load into finnyEMR)

```bash
node aquila-migrator.js \
  --url https://your-facility.aquila.ng \
  --user YOUR_AQUILA_USERNAME \
  --pass YOUR_AQUILA_PASSWORD \
  --finny-url http://your-finnyemr-url \
  --finny-origin http://localhost:3000 \
  --finny-user admin@facility.com \
  --finny-pass YOUR_PASSWORD \
  --tenant-id YOUR_TENANT_UUID \
  --out ~/migration-output \
  --batch-size 50
```

### Load only (extraction already done, data on disk)

```bash
node aquila-migrator.js --skip-extract [all other args]
```

### Retry previously failed patients only

```bash
node aquila-migrator.js --skip-extract --retry-failed [all other args]
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--url` | `https://springmed.aquila.ng` | Aquila base URL |
| `--user` | `springmed` | Aquila login username |
| `--pass` | `springmed` | Aquila login password |
| `--finny-url` | *(required)* | finnyEMR backend URL |
| `--finny-user` | *(required)* | finnyEMR staff email |
| `--finny-pass` | *(required)* | finnyEMR staff password |
| `--finny-origin` | `http://localhost:3000` | Origin header for Sanctum SPA auth |
| `--tenant-id` | *(required)* | finnyEMR tenant UUID for the facility |
| `--out` | `./migration-output` | Output directory for raw extracted files |
| `--batch-size` | `50` | Patients per page when fetching Aquila list |
| `--limit` | `0` (all) | Cap total patients extracted (for testing) |
| `--dry-run` | `false` | Extract only, skip loading into finnyEMR |
| `--skip-extract` | `false` | Skip Phase 1, use existing files in `--out/raw/` |
| `--retry-failed` | `false` | Only load patients listed in `failed-index.json` |

## Output files

After a run, `--out` contains:

- `raw/patients-index.json` — full patient list from Aquila
- `raw/patient-{id}.json` — raw extracted data per patient
- `raw/extract-report.json` — extraction summary
- `patient-id-map.json` — Aquila ID → finnyEMR UUID mapping
- `load-report.json` — load summary with per-patient success/failure detail
- `failed-index.json` — source IDs of patients that failed to load (for `--retry-failed`)

## What gets migrated

| Data | Notes |
|---|---|
| Patient demographics | Name, DOB, gender, phone (normalized to 11-digit NG format), address |
| Encounters | Chief complaint, clinical notes, examination, treatment plan, diagnoses |
| Vitals | Temp, BP, pulse, SpO2, weight, height — dated to the original encounter date |
| Prescriptions | Structured (fluid_consultation) and free-text (doctors_review) |
| Lab results | Each component (wbcc, pcv, hb, etc.) saved as a separate result row |

## Data quality notes

- Patients with no DOB in Aquila receive `1900-01-01` as a placeholder — staff should update these.
- Patients with no first name receive `"Unknown from Aquila"`.
- Phone numbers are normalized: 10-digit numbers get a leading `0`; numbers over 11 digits are truncated to 11.

## Resume / retry

The migrator is crash-safe:
- The patient index is saved page-by-page, so a mid-index crash resumes from where it stopped.
- Already-extracted `patient-{id}.json` files are skipped on restart.
- Network errors (socket hang up, timeout) are automatically retried up to 4 times with exponential backoff.
