const express          = require('express');
const { getOne, getAll } = require('../database/db');
const { sendContactEmail } = require('../utils/email');
const { detectSpam }   = require('../utils/antispam');
const router           = express.Router();

router.get('/', async (req, res) => {
  try {
    const featuredCars = await getAll(`
      SELECT c.*,
        (SELECT url FROM car_images WHERE car_id = c.id AND es_principal = 1 LIMIT 1) AS imagen_principal,
        (SELECT url FROM car_images WHERE car_id = c.id ORDER BY orden LIMIT 1)       AS imagen_primera,
        (SELECT COUNT(*) FROM car_images WHERE car_id = c.id)                         AS num_imagenes
      FROM cars c
      WHERE c.estado = 'disponible' AND c.destacado = 1
      ORDER BY c.created_at DESC LIMIT 6
    `);

    const recentCoches = await getAll(`
      SELECT c.*,
        (SELECT url FROM car_images WHERE car_id = c.id AND es_principal = 1 LIMIT 1) AS imagen_principal,
        (SELECT url FROM car_images WHERE car_id = c.id ORDER BY orden LIMIT 1)       AS imagen_primera,
        (SELECT COUNT(*) FROM car_images WHERE car_id = c.id)                         AS num_imagenes
      FROM cars c
      WHERE c.estado = 'disponible' AND c.categoria = 'coche'
      ORDER BY c.created_at DESC LIMIT 3
    `);

    const recentCampers = await getAll(`
      SELECT c.*,
        (SELECT url FROM car_images WHERE car_id = c.id AND es_principal = 1 LIMIT 1) AS imagen_principal,
        (SELECT url FROM car_images WHERE car_id = c.id ORDER BY orden LIMIT 1)       AS imagen_primera,
        (SELECT COUNT(*) FROM car_images WHERE car_id = c.id)                         AS num_imagenes
      FROM cars c
      WHERE c.estado = 'disponible' AND c.categoria = 'camper'
      ORDER BY c.created_at DESC LIMIT 3
    `);

    const [stTotal, stDisp, stCoches, stCampers] = await Promise.all([
      getOne("SELECT COUNT(*) AS n FROM cars"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE estado = 'disponible'"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE categoria = 'coche'  AND estado = 'disponible'"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE categoria = 'camper' AND estado = 'disponible'")
    ]);

    res.render('index', {
      title: 'Cars & Campers — Coches y autocaravanas seleccionados',
      featuredCars,
      recentCoches,
      recentCampers,
      stats: {
        total:      stTotal?.n || 0,
        disponible: stDisp?.n  || 0,
        coches:     stCoches?.n || 0,
        campers:    stCampers?.n || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error interno');
  }
});

router.get('/contacto', (req, res) => {
  res.render('contacto', { title: 'Contacto', form: {}, errors: null });
});

router.post('/contacto', async (req, res) => {
  const f = req.body || {};

  // ── ANTISPAM: honeypot + tiempo + rate-limit + keywords + ... ──
  const spam = detectSpam(req, f, ['nombre', 'mensaje']);
  if (spam.isSpam) {
    // Renderizamos "gracias" igualmente para no dar pistas al bot,
    // pero NO mandamos email a Resend.
    return res.render('gracias', {
      title: '¡Mensaje recibido!',
      tipo:  'contacto',
      nombre: (f.nombre || '').trim() || 'amigo',
      email:  (f.email  || '').trim()
    });
  }

  const errors = [];
  if (!f.nombre || !f.nombre.trim()) errors.push('nombre');
  if (!f.email  || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) errors.push('email');
  if (!f.mensaje || !f.mensaje.trim()) errors.push('mensaje');

  if (errors.length) {
    req.session.flash = { type: 'error', msg: 'Revisa los campos marcados.' };
    return res.render('contacto', { title: 'Contacto', form: f, errors });
  }

  const data = {
    nombre:   f.nombre.trim(),
    email:    f.email.trim().toLowerCase(),
    telefono: (f.telefono || '').trim(),
    mensaje:  f.mensaje.trim()
  };

  try {
    await sendContactEmail(data);
  } catch (err) {
    console.error('[contacto] Error enviando email:', err);
  }

  res.render('gracias', {
    title: '¡Mensaje recibido!',
    tipo:  'contacto',
    nombre: data.nombre,
    email:  data.email
  });
});

// ── SITEMAP XML (para Google Search Console) ──────────────────────
function toIsoDate(value) {
  if (!value) return null;
  // SQLite/Turso devuelve 'YYYY-MM-DD HH:MM:SS' (con espacio), no ISO
  const d = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

router.get('/sitemap.xml', async (req, res) => {
  const base = 'https://carscampers.com';
  const today = new Date().toISOString().split('T')[0];
  try {
    const cars = await getAll(
      "SELECT slug, created_at FROM cars WHERE estado = 'disponible' ORDER BY created_at DESC"
    );

    const staticPages = [
      { loc: '/',                                priority: '1.0', change: 'daily'   },
      { loc: '/coches',                          priority: '0.9', change: 'daily'   },
      { loc: '/coches/nacional',                 priority: '0.8', change: 'daily'   },
      { loc: '/coches/importacion',              priority: '0.8', change: 'daily'   },
      { loc: '/campers',                         priority: '0.9', change: 'daily'   },
      { loc: '/servicios',                       priority: '0.7', change: 'monthly' },
      { loc: '/servicios/vehiculos-a-la-carta',  priority: '0.7', change: 'monthly' },
      { loc: '/servicios/techos-elevables',      priority: '0.7', change: 'monthly' },
      { loc: '/contacto',                        priority: '0.6', change: 'monthly' }
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    for (const p of staticPages) {
      xml += `  <url>\n`;
      xml += `    <loc>${base}${p.loc}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${p.change}</changefreq>\n`;
      xml += `    <priority>${p.priority}</priority>\n`;
      xml += `  </url>\n`;
    }

    for (const car of cars) {
      const lastmod = toIsoDate(car.created_at) || today;
      xml += `  <url>\n`;
      xml += `    <loc>${base}/coches/${car.slug}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.8</priority>\n`;
      xml += `  </url>\n`;
    }

    xml += `</urlset>\n`;

    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error('[sitemap] error:', err);
    res.status(500).send('Error generando sitemap');
  }
});

module.exports = router;
