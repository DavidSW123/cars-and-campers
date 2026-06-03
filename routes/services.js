const express = require('express');
const { sendCustomCarEmail, sendPopTopRoofEmail } = require('../utils/email');
const { detectSpam } = require('../utils/antispam');
const router  = express.Router();

// ── GET /servicios — landing con 2 cards ─────────────────────────
router.get('/', (req, res) => {
  res.render('servicios-landing', { title: 'Servicios · Cars & Campers BCN' });
});

// ── GET /servicios/vehiculos-a-la-carta ──────────────────────────
router.get('/vehiculos-a-la-carta', (req, res) => {
  res.render('servicios-a-la-carta', { title: 'Vehículos a la carta', form: {}, errors: null });
});

// ── POST /servicios/vehiculos-a-la-carta ─────────────────────────
router.post('/vehiculos-a-la-carta', async (req, res) => {
  const f = req.body || {};

  // ── ANTISPAM ────────────────────────────────────────────────
  const spam = detectSpam(req, f, ['nombre', 'marca', 'modelo', 'comentarios']);
  if (spam.isSpam) {
    return res.render('gracias', {
      title: '¡Solicitud recibida!',
      tipo: 'a-la-carta',
      nombre: (f.nombre || '').trim() || 'amigo',
      email:  (f.email  || '').trim()
    });
  }

  const required = ['nombre', 'email', 'telefono', 'acepta_costes'];
  const errors = [];
  for (const k of required) if (!f[k] || (typeof f[k] === 'string' && !f[k].trim())) errors.push(k);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email || '')) errors.push('email');

  if (errors.length) {
    req.session.flash = { type: 'error', msg: 'Revisa los campos obligatorios y la aceptación de costes.' };
    return res.render('servicios-a-la-carta', { title: 'Vehículos a la carta', form: f, errors });
  }

  const data = {
    nombre:      f.nombre.trim(),
    email:       f.email.trim().toLowerCase(),
    telefono:    f.telefono.trim(),
    tipo:        f.tipo === 'camper' ? 'camper' : 'coche',
    marca:       (f.marca || '').trim(),
    modelo:      (f.modelo || '').trim(),
    anio_desde:  f.anio_desde || '',
    combustible: f.combustible || '',
    transmision: f.transmision || '',
    km_max:      f.km_max || '',
    presupuesto: f.presupuesto || '',
    comentarios: (f.comentarios || '').trim()
  };

  try {
    await sendCustomCarEmail(data);
  } catch (err) {
    console.error('[servicios/a-la-carta] Error enviando email:', err);
  }

  res.render('gracias', {
    title: '¡Solicitud recibida!',
    tipo: 'a-la-carta',
    nombre: data.nombre,
    email:  data.email
  });
});

// ── GET /servicios/techos-elevables ──────────────────────────────
router.get('/techos-elevables', (req, res) => {
  res.render('servicios-techos', { title: 'Techos elevables', form: {}, errors: null });
});

// ── POST /servicios/techos-elevables ─────────────────────────────
router.post('/techos-elevables', async (req, res) => {
  const f = req.body || {};

  // ── ANTISPAM ────────────────────────────────────────────────
  const spam = detectSpam(req, f, ['nombre', 'marca', 'modelo', 'comentarios']);
  if (spam.isSpam) {
    return res.render('gracias', {
      title: '¡Presupuesto solicitado!',
      tipo:  'techo-elevable',
      nombre: (f.nombre || '').trim() || 'amigo',
      email:  (f.email  || '').trim()
    });
  }

  const errors = [];
  if (!f.nombre   || !f.nombre.trim())   errors.push('nombre');
  if (!f.email    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) errors.push('email');
  if (!f.telefono || !f.telefono.trim()) errors.push('telefono');

  if (errors.length) {
    req.session.flash = { type: 'error', msg: 'Revisa los campos obligatorios.' };
    return res.render('servicios-techos', { title: 'Techos elevables', form: f, errors });
  }

  const data = {
    nombre:        f.nombre.trim(),
    email:         f.email.trim().toLowerCase(),
    telefono:      f.telefono.trim(),
    marca:         (f.marca || '').trim(),
    modelo:        (f.modelo || '').trim(),
    anio:          f.anio || '',
    tipo_techo:    f.tipo_techo || '',
    plazas_dormir: f.plazas_dormir || '',
    comentarios:   (f.comentarios || '').trim()
  };

  try {
    await sendPopTopRoofEmail(data);
  } catch (err) {
    console.error('[servicios/techos] Error enviando email:', err);
  }

  res.render('gracias', {
    title: '¡Presupuesto solicitado!',
    tipo:  'techo-elevable',
    nombre: data.nombre,
    email:  data.email
  });
});

module.exports = router;
