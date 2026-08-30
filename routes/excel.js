const multer = require('multer');
const ExcelJS = require('exceljs');
const { asyncRouter } = require('./_async');
const db = require('../db');
const { insertRow, updateRow } = require('./_dynamicSql');
const { resolveCoursId, resolveStudentId } = require('./_resolveIds');

const router = asyncRouter();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function cell(row, idx) {
  const v = row.getCell(idx).value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(part => part.text).join('').trim();
    if (v.result !== undefined) return cellValueToString(v.result);
    if (v.text !== undefined) return String(v.text).trim();
    if (v.hyperlink !== undefined) return String(v.hyperlink).trim();
    return '';
  }
  return String(v).trim();
}

function cellValueToString(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return '';
  return String(v).trim();
}

// Comme cell(), mais renvoie une simple date "YYYY-MM-DD" (sans heure) pour les colonnes de date
function cellDate(row, idx) {
  const v = row.getCell(idx).value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = cell(row, idx);
  if (s && /^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s;
}

// Excel stocke une heure comme une fraction de journée (0.375 = 09:00), avec un format d'affichage
// "hh:mm" appliqué à la cellule — mais ExcelJS ne renvoie un objet Date que pour les cellules Date
// complètes ; une cellule "heure seule" reste un nombre brut (ou un résultat de formule numérique).
function excelSerialToHHMM(v) {
  const totalMinutes = Math.round(v * 24 * 60);
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Renvoie "HH:MM" pour une cellule représentant une heure : nombre fractionnaire, résultat de
// formule (partagée ou non), Date, ou texte déjà au format HH:MM.
function cellTimeHHMM(row, idx) {
  const v = row.getCell(idx).value;
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
  if (typeof v === 'number') return excelSerialToHHMM(v);
  if (typeof v === 'object') {
    if (v.result !== undefined) {
      if (typeof v.result === 'number') return excelSerialToHHMM(v.result);
      if (v.result instanceof Date) return `${String(v.result.getUTCHours()).padStart(2, '0')}:${String(v.result.getUTCMinutes()).padStart(2, '0')}`;
    }
    if (Array.isArray(v.richText)) return v.richText.map(part => part.text).join('').trim() || null;
    if (v.text !== undefined) return String(v.text).trim() || null;
    return null;
  }
  const s = String(v).trim();
  return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5) : (s || null);
}

// Combine une date "YYYY-MM-DD" et une heure "HH:MM" en un horodatage complet (heure locale -> ISO),
// pour heure_arrivee / heure_expulsion qui sont stockées comme des instants complets dans l'app
// (mêmes conventions que la saisie live, cf. pointage.js `/arrivee`).
function combineDateTime(dateStr, hhmm) {
  if (!hhmm) return null;
  const d = dateStr || new Date().toISOString().slice(0, 10);
  const parsed = new Date(`${d}T${hhmm}:00`);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ---------- Import piloté par les en-têtes (colonne trouvée par nom, pas par position) ----------
// Rend l'import robuste à l'ordre des colonnes dans le fichier source, et permet de retirer une
// colonne native de la base sans décaler silencieusement les colonnes suivantes à l'import suivant.
function normalizeHeader(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function headerText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(p => p.text).join('');
    if (v.text !== undefined) return String(v.text);
    return '';
  }
  return String(v);
}
function buildHeaderMap(ws) {
  const map = new Map();
  if (!ws) return map;
  const headerRow = ws.getRow(1);
  for (let i = 1; i <= ws.columnCount; i++) {
    const norm = normalizeHeader(headerText(headerRow.getCell(i).value));
    if (norm && !map.has(norm)) map.set(norm, i);
  }
  return map;
}
function findColumn(headerMap, labels) {
  for (const label of labels) {
    const idx = headerMap.get(normalizeHeader(label));
    if (idx) return idx;
  }
  return null;
}
function extractBySpec(row, idx, spec, dateForCombine) {
  if (idx == null) return undefined; // colonne absente du fichier : on n'y touche pas
  if (spec.type === 'date') return cellDate(row, idx);
  if (spec.type === 'heure') return cellTimeHHMM(row, idx);
  if (spec.type === 'heure_iso') return combineDateTime(dateForCombine, cellTimeHHMM(row, idx));
  return cell(row, idx);
}

// ExcelJS n'attend pas les callbacks asynchrones passés à eachRow : on matérialise d'abord les
// lignes (parcours synchrone), puis on les insère dans une boucle qui peut, elle, attendre Postgres.
function dataRows(ws) {
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber !== 1) rows.push(row);
  });
  return rows;
}

const BUILTIN_SPECS = {
  students: [
    { key: 'external_id', headers: ['ID'] },
    { key: 'nom', headers: ['Nom'] },
    { key: 'prenom', headers: ['Prénom', 'Prenom'] },
    { key: 'classe', headers: ['Classe'] },
    { key: 'niveau', headers: ['Niveau'] },
    { key: 'ecole', headers: ['Ecole', 'École'] },
  ],
  courses: [
    { key: 'ecole', headers: ['Ecole', 'École'] },
    { key: 'cours', headers: ['Cours'] },
    { key: 'niveau', headers: ['Niveau'] },
    { key: 'vh', headers: ['VH'] },
    { key: 'nb_seances', headers: ['Nombre de séances', 'Nb séances'] },
  ],
  pointage: [
    { key: 'nom', headers: ['Nom'] },
    { key: 'prenom', headers: ['Prénom', 'Prenom'] },
    { key: 'date', headers: ['Date'], type: 'date' },
    { key: 'ecole', headers: ['Ecole', 'École'] },
    { key: 'cours', headers: ['Cours'] },
    { key: 'niveau', headers: ['Niveau'] },
    { key: 'classe', headers: ['Classe'] },
    { key: 'heure_debut', headers: ['Heure de début', 'Heure de debut'], type: 'heure' },
    { key: 'heure_fin', headers: ['Heure de fin'], type: 'heure' },
    { key: 'heure_arrivee', headers: ['Heure de présence', 'Heure de presence', "Heure d'arrivée"], type: 'heure_iso' },
    { key: 'heure_expulsion', headers: ["Heure d'expulsion", 'Heure expulsion'], type: 'heure_iso' },
    { key: 'raison_expulsion', headers: ["Raison d'expulsion", 'Raison expulsion'] },
  ],
};

// Colonnes personnalisées (field_defs, hors liaisons calculées) : matchées par leur libellé.
async function customSpecsFor(table) {
  const rows = await db.prepare(`SELECT field_key, label FROM field_defs WHERE table_name = ? AND is_builtin = 0`).all(table);
  return rows.map(f => ({ key: f.field_key, headers: [f.label], custom: true }));
}

router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);

    const summary = { etudiants: 0, cours: 0, pointage: 0 };

    const wsEtudiants = wb.getWorksheet('Etudiants');
    if (wsEtudiants) {
      const headerMap = buildHeaderMap(wsEtudiants);
      const specs = [...BUILTIN_SPECS.students, ...await customSpecsFor('students')];
      const cols = specs.map(spec => ({ spec, idx: findColumn(headerMap, spec.headers) }));
      const rows = dataRows(wsEtudiants);
      const tx = db.transaction(async () => {
        for (const row of rows) {
          const values = {};
          const extra = {};
          for (const { spec, idx } of cols) {
            const v = extractBySpec(row, idx, spec);
            if (v === undefined) continue;
            if (spec.custom) extra[spec.key] = v; else values[spec.key] = v;
          }
          if (!values.nom && !values.prenom) continue;
          await insertRow(db, 'students', {
            code: await db.nextStudentCode(values.ecole), external_id: values.external_id || null, nom: values.nom || '',
            prenom: values.prenom || '', classe: values.classe || null, niveau: values.niveau || null, ecole: values.ecole || null,
            extra: JSON.stringify(extra),
          });
          summary.etudiants++;
        }
      });
      await tx();
    }

    const wsCours = wb.getWorksheet('Cours');
    if (wsCours) {
      const headerMap = buildHeaderMap(wsCours);
      const specs = [...BUILTIN_SPECS.courses, ...await customSpecsFor('courses')];
      const cols = specs.map(spec => ({ spec, idx: findColumn(headerMap, spec.headers) }));
      const rows = dataRows(wsCours);
      const tx = db.transaction(async () => {
        for (const row of rows) {
          const values = {};
          const extra = {};
          for (const { spec, idx } of cols) {
            const v = extractBySpec(row, idx, spec);
            if (v === undefined) continue;
            if (spec.custom) extra[spec.key] = v; else values[spec.key] = v;
          }
          if (!values.cours) continue;
          await insertRow(db, 'courses', {
            code: await db.nextCourseCode(values.ecole, values.niveau), ecole: values.ecole || null, cours: values.cours,
            niveau: values.niveau || null, vh: values.vh || null, nb_seances: values.nb_seances || null, extra: JSON.stringify(extra),
          });
          summary.cours++;
        }
      });
      await tx();
    }

    const wsPointage = wb.getWorksheet('Pointage');
    if (wsPointage) {
      const headerMap = buildHeaderMap(wsPointage);
      const specs = [...BUILTIN_SPECS.pointage, ...await customSpecsFor('pointage')];
      const cols = specs.map(spec => ({ spec, idx: findColumn(headerMap, spec.headers) }));
      const dateIdx = findColumn(headerMap, BUILTIN_SPECS.pointage.find(s => s.key === 'date').headers);
      // Retrouve une ligne déjà existante pour la même session (date+ecole+cours) et le même étudiant
      // (par ID si résolu, sinon par nom+prénom) : on met à jour cette ligne plutôt que d'en insérer une
      // seconde en doublon — sinon une heure de présence/expulsion importée après coup pouvait finir sur
      // une ligne fantôme jamais consultée pendant qu'on regardait l'ancienne ligne, sans présence.
      // La ligne existante peut dater d'avant la résolution d'ID (student_id NULL) : on matche par ID
      // quand on en a un des deux côtés, sinon on retombe sur nom+prénom pour les lignes non-résolues.
      // Les casts ::bigint sont indispensables : Postgres refuse un paramètre nu dans `? IS NOT NULL`,
      // dont il ne peut pas déduire le type.
      const findExisting = db.prepare(
        `SELECT id FROM pointage WHERE date = ? AND COALESCE(ecole,'') = COALESCE(?,'') AND COALESCE(cours,'') = COALESCE(?,'')
         AND (
           (?::bigint IS NOT NULL AND student_id = ?::bigint)
           OR (student_id IS NULL AND UPPER(TRIM(COALESCE(nom,''))) = UPPER(TRIM(?)) AND UPPER(TRIM(COALESCE(prenom,''))) = UPPER(TRIM(?)))
         ) LIMIT 1`
      );
      const rows = dataRows(wsPointage);
      let updated = 0;
      const tx = db.transaction(async () => {
        for (const row of rows) {
          const rowDate = dateIdx ? cellDate(row, dateIdx) : null;
          const values = {};
          const extra = {};
          for (const { spec, idx } of cols) {
            const v = extractBySpec(row, idx, spec, rowDate);
            if (v === undefined) continue;
            if (spec.custom) extra[spec.key] = v; else values[spec.key] = v;
          }
          if (!values.nom && !values.prenom) continue;
          const student_id = await resolveStudentId(values.nom, values.prenom, values.ecole);
          const cours_id = await resolveCoursId(values.ecole, values.cours, values.niveau);
          const fields = {
            student_id, cours_id, nom: values.nom || '', prenom: values.prenom || '', classe: values.classe || null,
            ecole: values.ecole || null, cours: values.cours || null, niveau: values.niveau || null, date: values.date || null,
            heure_debut: values.heure_debut || null, heure_fin: values.heure_fin || null, heure_arrivee: values.heure_arrivee || null,
            heure_expulsion: values.heure_expulsion || null, raison_expulsion: values.raison_expulsion || null, extra: JSON.stringify(extra),
          };
          const existing = values.date
            ? await findExisting.get(values.date, values.ecole || null, values.cours || null, student_id, student_id, values.nom || '', values.prenom || '')
            : null;
          if (existing) {
            await updateRow(db, 'pointage', existing.id, fields);
            updated++;
          } else {
            await insertRow(db, 'pointage', { code: await db.nextPointageCode(values.date), ...fields });
          }
          summary.pointage++;
        }
      });
      await tx();
      summary.pointageUpdated = updated;
    }

    res.json({ ok: true, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Échec de l'import : " + err.message });
  }
});

router.get('/export', async (req, res) => {
  const wb = new ExcelJS.Workbook();

  const wsE = wb.addWorksheet('Etudiants');
  wsE.addRow(['ID', 'Nom', 'Prénom', 'Nom et Prénom', 'Classe', 'Niveau', 'Ecole']);
  for (const s of await db.prepare(`SELECT * FROM students ORDER BY nom, prenom`).all()) {
    wsE.addRow([s.external_id || s.id, s.nom, s.prenom, `${s.nom} ${s.prenom}`, s.classe, s.niveau, s.ecole]);
  }

  const wsC = wb.addWorksheet('Cours');
  wsC.addRow(['Ecole', 'Cours', 'Niveau', 'VH', 'Nombre de séances']);
  for (const c of await db.prepare(`SELECT * FROM courses ORDER BY ecole, cours`).all()) {
    wsC.addRow([c.ecole, c.cours, c.niveau, c.vh, c.nb_seances]);
  }

  // Heure de présence / d'expulsion sont stockées en base comme des horodatages complets (ISO) ;
  // on n'exporte que la partie heure locale "HH:MM", pour rester ré-important tel quel (cf. cellTimeHHMM).
  function isoToHHMM(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const wsP = wb.addWorksheet('Pointage');
  wsP.addRow(['Nom', 'Prénom', 'Nom et prénom', 'Date', 'Ecole', 'Cours', 'Niveau', 'Heure de début', 'Heure de fin', 'Heure de présence', "Heure d'expulsion", "Raison d'expulsion"]);
  for (const p of await db.prepare(`SELECT * FROM pointage ORDER BY date, nom, prenom`).all()) {
    wsP.addRow([p.nom, p.prenom, `${p.nom} ${p.prenom}`, p.date, p.ecole, p.cours, p.niveau, p.heure_debut, p.heure_fin, isoToHHMM(p.heure_arrivee), isoToHHMM(p.heure_expulsion), p.raison_expulsion]);
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Pointage-export.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
