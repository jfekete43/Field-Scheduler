'use strict';

/**
 * Seeds the four JHLL locations and their fields.
 * Safe to re-run: existing locations/fields are matched by slug and updated,
 * never duplicated, and admin-entered addresses are left alone.
 */

const { db, logAction } = require('../src/db');

const LOCATIONS = [
  {
    slug: 'holbrook',
    name: 'Holbrook',
    // Addresses are seeded as map search strings that work in Google/Apple Maps.
    // Admins should confirm the exact street address in Admin > Locations.
    address: 'Holbrook Complex, Jackson Township, NJ',
    maps_query: 'Holbrook Little League Complex, Jackson Township, NJ',
    notes: 'Home of the indoor batting cages.',
    sort_order: 1,
    fields: [
      { slug: 'farm', name: 'Farm', kind: 'baseball' },
      { slug: 'aa', name: 'AA', kind: 'baseball' },
      { slug: 'aaa', name: 'AAA', kind: 'baseball' },
      { slug: 'majors', name: 'Majors', kind: 'baseball' },
      { slug: '60-90', name: '60/90', kind: 'baseball' },
      { slug: 'indoor-cages', name: 'Indoor Cages', kind: 'cage' },
    ],
  },
  {
    slug: 'justice',
    name: 'Justice',
    address: 'Justice Complex, Jackson Township, NJ',
    maps_query: 'Justice Complex, Jackson Township, NJ',
    notes: '',
    sort_order: 2,
    fields: [
      { slug: 'grass-a', name: 'Grass A', kind: 'baseball' },
      { slug: 'grass-b', name: 'Grass B', kind: 'baseball' },
      { slug: 'turf-1', name: 'Turf 1', kind: 'turf' },
      { slug: 'turf-2', name: 'Turf 2', kind: 'turf' },
      { slug: 'softball', name: 'Softball', kind: 'softball' },
    ],
  },
  {
    slug: 'bartley',
    name: 'Bartley',
    address: 'Bartley Road, Jackson Township, NJ',
    maps_query: 'Bartley Road Fields, Jackson Township, NJ',
    notes: '',
    sort_order: 3,
    fields: [
      { slug: 'field-1', name: 'Field 1', kind: 'baseball' },
      { slug: 'field-2', name: 'Field 2', kind: 'baseball' },
    ],
  },
  {
    slug: '527',
    name: '527',
    address: 'County Route 527, Jackson Township, NJ',
    maps_query: 'County Route 527 Fields, Jackson Township, NJ',
    notes: '',
    sort_order: 4,
    fields: [
      { slug: 'minors', name: 'Minors', kind: 'baseball' },
      { slug: 'majors', name: 'Majors', kind: 'baseball' },
      { slug: '60-90', name: '60/90', kind: 'baseball' },
    ],
  },
];

const findLocation = db.prepare('SELECT * FROM locations WHERE slug = ?');
const insertLocation = db.prepare(
  `INSERT INTO locations (slug, name, address, maps_query, notes, sort_order)
   VALUES (@slug, @name, @address, @maps_query, @notes, @sort_order)`
);
const updateLocationMeta = db.prepare(
  'UPDATE locations SET name = ?, sort_order = ? WHERE id = ?'
);

const findField = db.prepare('SELECT * FROM fields WHERE location_id = ? AND slug = ?');
const insertField = db.prepare(
  `INSERT INTO fields (location_id, slug, name, kind, sort_order)
   VALUES (@location_id, @slug, @name, @kind, @sort_order)`
);
const updateField = db.prepare('UPDATE fields SET name = ?, kind = ?, sort_order = ? WHERE id = ?');

let created = 0;
let updated = 0;

const run = db.transaction(() => {
  for (const loc of LOCATIONS) {
    let row = findLocation.get(loc.slug);
    if (!row) {
      insertLocation.run({
        slug: loc.slug,
        name: loc.name,
        address: loc.address,
        maps_query: loc.maps_query,
        notes: loc.notes,
        sort_order: loc.sort_order,
      });
      row = findLocation.get(loc.slug);
      created += 1;
      console.log(`+ location  ${loc.name}`);
    } else {
      updateLocationMeta.run(loc.name, loc.sort_order, row.id);
      updated += 1;
    }

    loc.fields.forEach((field, index) => {
      const existing = findField.get(row.id, field.slug);
      if (!existing) {
        insertField.run({
          location_id: row.id,
          slug: field.slug,
          name: field.name,
          kind: field.kind,
          sort_order: index + 1,
        });
        created += 1;
        console.log(`+ field     ${loc.name} / ${field.name}`);
      } else {
        updateField.run(field.name, field.kind, index + 1, existing.id);
        updated += 1;
      }
    });
  }
});

run();
logAction(null, 'seed', 'locations', '', `created=${created} updated=${updated}`);

const counts = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM locations) AS locations,
            (SELECT COUNT(*) FROM fields)    AS fields`
  )
  .get();

console.log(`\nSeed complete. created=${created} updated=${updated}`);
console.log(`Totals: ${counts.locations} locations, ${counts.fields} fields.`);
