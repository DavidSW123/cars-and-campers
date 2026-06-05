const express            = require('express');
const bcrypt             = require('bcryptjs');
const slugify            = require('slugify');
const { getOne, getAll, run, getSettings, setSetting } = require('../database/db');
const { requireAdmin }   = require('../middleware/auth');
const upload             = require('../middleware/upload');
const { detectMediaType } = require('../middleware/upload');
const { upload: uploadImg, uploadLogo, deleteImage } = require('../utils/imageUpload');
const MARCAS_MODELOS     = require('../utils/car-models');
const router             = express.Router();

function makeSlug(marca, modelo, anio) {
  const base = slugify(`${marca} ${modelo} ${anio}`, { lower: true, strict: true });
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

// ══════════════════════════════════════════════════════════════════
// AUTH (login / logout) – fuera del middleware requireAdmin
// ══════════════════════════════════════════════════════════════════
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  res.render('login', { title: 'Acceso administradores' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('[LOGIN] intento con email:', email);
  if (!email || !password) {
    req.session.flash = { type: 'error', msg: 'Rellena todos los campos.' };
    return res.redirect('/admin/login');
  }
  try {
    const user = await getOne('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (!user) {
      console.log('[LOGIN] FAIL: usuario no encontrado');
      req.session.flash = { type: 'error', msg: 'Credenciales incorrectas (email no existe).' };
      return res.redirect('/admin/login');
    }
    if (!bcrypt.compareSync(password, user.password)) {
      console.log('[LOGIN] FAIL: password no coincide para', email);
      req.session.flash = { type: 'error', msg: 'Credenciales incorrectas (contraseña).' };
      return res.redirect('/admin/login');
    }
    if (user.role !== 'admin') {
      console.log('[LOGIN] FAIL: usuario no es admin (role=' + user.role + ')');
      req.session.flash = { type: 'error', msg: 'Esta cuenta no tiene permisos de administrador.' };
      return res.redirect('/admin/login');
    }
    req.session.user = { id: Number(user.id), nombre: user.nombre, email: user.email, role: user.role };
    req.session.flash = { type: 'success', msg: `Bienvenido, ${user.nombre.split(' ')[0]}!` };
    console.log('[LOGIN] OK:', email, '→ redirect a', req.query.redirect || '/admin');
    res.redirect(req.query.redirect || '/admin');
  } catch (err) {
    console.error('[LOGIN] error:', err);
    req.session.flash = { type: 'error', msg: 'Error al iniciar sesión.' };
    res.redirect('/admin/login');
  }
});

router.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ══════════════════════════════════════════════════════════════════
// A partir de aquí: solo administradores
// ══════════════════════════════════════════════════════════════════
router.use(requireAdmin);

// ── Dashboard ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [stDisp, stRes, stVend, stTotal, stCoches, stCampers, stDest, recentCars] = await Promise.all([
      getOne("SELECT COUNT(*) AS n FROM cars WHERE estado = 'disponible'"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE estado = 'reservado'"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE estado = 'vendido'"),
      getOne("SELECT COUNT(*) AS n FROM cars"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE categoria = 'coche'"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE categoria = 'camper'"),
      getOne("SELECT COUNT(*) AS n FROM cars WHERE destacado = 1"),
      getAll(`SELECT c.*, (SELECT url FROM car_images WHERE car_id = c.id ORDER BY orden LIMIT 1) AS imagen_primera
              FROM cars c ORDER BY c.created_at DESC LIMIT 5`)
    ]);
    const stats = {
      disponible: stDisp?.n || 0, reservado: stRes?.n || 0, vendido: stVend?.n || 0,
      total: stTotal?.n || 0, coches: stCoches?.n || 0, campers: stCampers?.n || 0, destacados: stDest?.n || 0
    };
    res.render('admin/dashboard', { title: 'Dashboard', stats, recentCars });
  } catch (err) { console.error(err); res.status(500).send('Error interno'); }
});

// ── Vehículos: listado ────────────────────────────────────────────
router.get('/coches', async (req, res) => {
  try {
    const cars = await getAll(`
      SELECT c.*,
        (SELECT url FROM car_images WHERE car_id = c.id ORDER BY orden LIMIT 1) AS imagen_primera,
        (SELECT COUNT(*) FROM car_images WHERE car_id = c.id)                   AS num_imagenes
      FROM cars c ORDER BY c.created_at DESC
    `);
    res.render('admin/coches', { title: 'Gestión de vehículos', cars });
  } catch (err) { console.error(err); res.status(500).send('Error interno'); }
});

// ── Vehículos: nuevo formulario ───────────────────────────────────
router.get('/coches/nuevo', (req, res) => {
  res.render('admin/coche-form', {
    title: 'Añadir vehículo',
    car: null, images: [],
    marcasModelos: MARCAS_MODELOS
  });
});

// ── Vehículos: crear ──────────────────────────────────────────────
router.post('/coches', upload.array('imagenes', 15), async (req, res) => {
  const { categoria, origen, marca, modelo, anio, precio, kilometraje, combustible, transmision,
          pais_origen, color, potencia, puertas, plazas, descripcion, estado, destacado } = req.body;
  if (!marca || !modelo || !anio || !precio || !kilometraje || !combustible || !transmision || !pais_origen) {
    req.session.flash = { type: 'error', msg: 'Rellena todos los campos obligatorios.' };
    return res.redirect('/admin/coches/nuevo');
  }
  try {
    const slug   = makeSlug(marca, modelo, anio);
    const result = await run(`
      INSERT INTO cars (categoria, origen, marca, modelo, anio, precio, kilometraje, combustible, transmision,
        pais_origen, color, potencia, puertas, plazas, descripcion, estado, destacado, slug)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [categoria === 'camper' ? 'camper' : 'coche',
        origen === 'importacion' ? 'importacion' : 'nacional',
        marca, modelo, parseInt(anio), parseFloat(precio), parseInt(kilometraje),
        combustible, transmision, pais_origen, color || null,
        potencia ? parseInt(potencia) : null, parseInt(puertas) || 4,
        plazas ? parseInt(plazas) : null,
        descripcion || null, estado || 'disponible', destacado ? 1 : 0, slug]);

    const carId = result.lastInsertRowid;

    if (req.files?.length > 0) {
      // Ordenar imágenes primero, vídeos después. Y la principal es
      // la primera imagen (los vídeos nunca van como principal).
      const imgs = req.files.filter(f => detectMediaType(f.originalname) === 'imagen');
      const vids = req.files.filter(f => detectMediaType(f.originalname) === 'video');
      const ordered = [...imgs, ...vids];

      let firstImgIdx = imgs.length > 0 ? 0 : -1;
      for (let i = 0; i < ordered.length; i++) {
        const file = ordered[i];
        const tipo = detectMediaType(file.originalname);
        const { url, cloud_id } = await uploadImg(file.buffer, file.originalname, carId);
        const esPrincipal = (tipo === 'imagen' && i === firstImgIdx) ? 1 : 0;
        await run(
          'INSERT INTO car_images (car_id, url, cloud_id, orden, es_principal, tipo) VALUES (?, ?, ?, ?, ?, ?)',
          [carId, url, cloud_id, i, esPrincipal, tipo]
        );
      }
    }
    req.session.flash = { type: 'success', msg: 'Vehículo añadido correctamente.' };
    res.redirect(`/admin/coches/${carId}/editar`);
  } catch (err) { console.error(err); req.session.flash = { type: 'error', msg: 'Error al crear el vehículo.' }; res.redirect('/admin/coches/nuevo'); }
});

// ── Vehículos: editar formulario ──────────────────────────────────
router.get('/coches/:id/editar', async (req, res) => {
  try {
    const car    = await getOne('SELECT * FROM cars WHERE id = ?', [req.params.id]);
    if (!car) { req.session.flash = { type: 'error', msg: 'Vehículo no encontrado.' }; return res.redirect('/admin/coches'); }
    const images = await getAll('SELECT * FROM car_images WHERE car_id = ? ORDER BY es_principal DESC, orden ASC', [Number(car.id)]);
    res.render('admin/coche-form', {
      title: `Editar: ${car.marca} ${car.modelo}`,
      car, images,
      marcasModelos: MARCAS_MODELOS
    });
  } catch (err) { console.error(err); res.status(500).send('Error interno'); }
});

// ── Vehículos: actualizar ─────────────────────────────────────────
// El form del editar usa enctype="multipart/form-data" (para que la
// creación pueda subir imágenes). En la edición no hay archivos,
// pero seguimos necesitando multer para que parsee los campos de
// texto, si no req.body queda vacío.
router.post('/coches/:id', upload.none(), async (req, res) => {
  const { categoria, origen, marca, modelo, anio, precio, kilometraje, combustible, transmision,
          pais_origen, color, potencia, puertas, plazas, descripcion, estado, destacado } = req.body;
  try {
    await run(`UPDATE cars SET categoria=?,origen=?,marca=?,modelo=?,anio=?,precio=?,kilometraje=?,combustible=?,
      transmision=?,pais_origen=?,color=?,potencia=?,puertas=?,plazas=?,descripcion=?,estado=?,destacado=? WHERE id=?`,
      [categoria === 'camper' ? 'camper' : 'coche',
       origen === 'importacion' ? 'importacion' : 'nacional',
       marca, modelo, parseInt(anio), parseFloat(precio), parseInt(kilometraje),
       combustible, transmision, pais_origen, color || null,
       potencia ? parseInt(potencia) : null, parseInt(puertas) || 4,
       plazas ? parseInt(plazas) : null,
       descripcion || null, estado, destacado ? 1 : 0, req.params.id]);
    req.session.flash = { type: 'success', msg: 'Vehículo actualizado.' };
    res.redirect(`/admin/coches/${req.params.id}/editar`);
  } catch (err) { console.error(err); req.session.flash = { type: 'error', msg: 'Error al actualizar.' }; res.redirect(`/admin/coches/${req.params.id}/editar`); }
});

// ── Vehículos: eliminar ───────────────────────────────────────────
router.post('/coches/:id/eliminar', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const images = await getAll('SELECT url, cloud_id FROM car_images WHERE car_id = ?', [id]);
    await Promise.all(images.map(img => deleteImage(img.url, img.cloud_id)));
    await run('DELETE FROM car_images WHERE car_id = ?', [id]);
    await run('DELETE FROM cars WHERE id = ?', [id]);
  } catch (err) { console.error(err); }
  req.session.flash = { type: 'success', msg: 'Vehículo eliminado.' };
  res.redirect('/admin/coches');
});

// ── Imágenes / vídeos: subir ──────────────────────────────────────
router.post('/coches/:id/imagenes', upload.array('imagenes', 20), async (req, res) => {
  const carId = parseInt(req.params.id);
  const countImgs = await getOne(
    "SELECT COUNT(*) AS n FROM car_images WHERE car_id = ? AND tipo = 'imagen'", [carId]
  );
  const currentImgs = countImgs?.n || 0;
  const countAll = await getOne('SELECT COUNT(*) AS n FROM car_images WHERE car_id = ?', [carId]);
  const currentAll = countAll?.n || 0;

  if (!req.files?.length) {
    req.session.flash = { type: 'error', msg: 'No se seleccionaron archivos.' };
    return res.redirect(`/admin/coches/${carId}/editar`);
  }
  const toAdd = req.files.slice(0, 25); // safety cap
  let added = { imagen: 0, video: 0 };
  for (let i = 0; i < toAdd.length; i++) {
    const file = toAdd[i];
    const tipo = detectMediaType(file.originalname);
    const { url, cloud_id } = await uploadImg(file.buffer, file.originalname, carId);
    // La principal sólo se asigna si es la PRIMERA imagen del coche
    const esPrincipal = (tipo === 'imagen' && currentImgs === 0 && added.imagen === 0) ? 1 : 0;
    await run(
      'INSERT INTO car_images (car_id, url, cloud_id, orden, es_principal, tipo) VALUES (?, ?, ?, ?, ?, ?)',
      [carId, url, cloud_id, currentAll + i, esPrincipal, tipo]
    );
    added[tipo]++;
  }
  const parts = [];
  if (added.imagen) parts.push(`${added.imagen} imagen${added.imagen > 1 ? 'es' : ''}`);
  if (added.video)  parts.push(`${added.video} vídeo${added.video > 1 ? 's' : ''}`);
  req.session.flash = { type: 'success', msg: `Añadido${parts.length > 1 ? 's' : ''}: ${parts.join(' y ')}.` };
  res.redirect(`/admin/coches/${carId}/editar`);
});

// ── Imágenes: eliminar ────────────────────────────────────────────
router.post('/imagenes/:imageId/eliminar', async (req, res) => {
  const img = await getOne('SELECT * FROM car_images WHERE id = ?', [req.params.imageId]);
  if (!img) return res.redirect('/admin/coches');
  await deleteImage(img.url, img.cloud_id);
  await run('DELETE FROM car_images WHERE id = ?', [Number(img.id)]);
  if (img.es_principal) {
    // Asigna como principal la siguiente IMAGEN (no vídeo)
    const next = await getOne(
      "SELECT id FROM car_images WHERE car_id = ? AND tipo = 'imagen' ORDER BY orden LIMIT 1",
      [Number(img.car_id)]
    );
    if (next) await run('UPDATE car_images SET es_principal = 1 WHERE id = ?', [Number(next.id)]);
  }
  const label = img.tipo === 'video' ? 'Vídeo' : 'Imagen';
  req.session.flash = { type: 'success', msg: `${label} eliminado.` };
  res.redirect(`/admin/coches/${img.car_id}/editar`);
});

// ── Coche: marcar/desmarcar Super Destacado del mes ─────────────
// Solo puede haber UNO activo. Si se marca, desmarcamos cualquier otro.
router.post('/coches/:id/super-destacado', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const car = await getOne('SELECT id, super_destacado, marca, modelo FROM cars WHERE id = ?', [id]);
    if (!car) {
      req.session.flash = { type: 'error', msg: 'Vehículo no encontrado.' };
      return res.redirect('/admin/coches');
    }
    if (car.super_destacado) {
      // Estaba marcado → desmarcar
      await run('UPDATE cars SET super_destacado = 0 WHERE id = ?', [id]);
      req.session.flash = { type: 'success', msg: `"${car.marca} ${car.modelo}" ya no es el Super Destacado.` };
    } else {
      // Marcar este, desmarcar los demás
      await run('UPDATE cars SET super_destacado = 0');
      await run('UPDATE cars SET super_destacado = 1 WHERE id = ?', [id]);
      req.session.flash = { type: 'success', msg: `★ "${car.marca} ${car.modelo}" es ahora el Super Destacado del Mes.` };
    }
    res.redirect(req.get('referer') || '/admin/coches');
  } catch (err) {
    console.error(err);
    req.session.flash = { type: 'error', msg: 'Error al actualizar Super Destacado.' };
    res.redirect('/admin/coches');
  }
});

// ── Imágenes: marcar principal ────────────────────────────────────
router.post('/imagenes/:imageId/principal', async (req, res) => {
  const img = await getOne('SELECT * FROM car_images WHERE id = ?', [req.params.imageId]);
  if (!img) return res.redirect('/admin/coches');
  if (img.tipo === 'video') {
    req.session.flash = { type: 'error', msg: 'Sólo las imágenes pueden ser principal.' };
    return res.redirect(`/admin/coches/${img.car_id}/editar`);
  }
  await run('UPDATE car_images SET es_principal = 0 WHERE car_id = ?', [Number(img.car_id)]);
  await run('UPDATE car_images SET es_principal = 1 WHERE id = ?', [Number(img.id)]);
  req.session.flash = { type: 'success', msg: 'Imagen principal actualizada.' };
  res.redirect(`/admin/coches/${img.car_id}/editar`);
});

// ── Administradores ───────────────────────────────────────────────
router.get('/usuarios', async (req, res) => {
  try {
    const users = await getAll(`SELECT id, nombre, email, role, created_at FROM users ORDER BY created_at ASC`);
    res.render('admin/usuarios', { title: 'Administradores', users });
  } catch (err) { console.error(err); res.status(500).send('Error interno'); }
});

// ── Ajustes / Branding ────────────────────────────────────────────
router.get('/ajustes', async (req, res) => {
  try {
    const settings = await getSettings();
    res.render('admin/ajustes', { title: 'Ajustes', settings });
  } catch (err) { console.error(err); res.status(500).send('Error interno'); }
});

router.post('/ajustes', async (req, res) => {
  await setSetting('show_logo', req.body.show_logo === '1' ? '1' : '0');
  req.session.flash = { type: 'success', msg: 'Ajustes guardados.' };
  res.redirect('/admin/ajustes');
});

router.post('/ajustes/logo', upload.single('logo'), async (req, res) => {
  if (!req.file) {
    req.session.flash = { type: 'error', msg: 'Selecciona una imagen.' };
    return res.redirect('/admin/ajustes');
  }
  try {
    // borrar logo anterior si existía
    const current = await getSettings();
    if (current.logo_url) {
      try { await deleteImage(current.logo_url, current.logo_cloud_id); } catch (_) {}
    }
    const { url, cloud_id } = await uploadLogo(req.file.buffer, req.file.originalname);
    await setSetting('logo_url', url);
    await setSetting('logo_cloud_id', cloud_id || '');
    req.session.flash = { type: 'success', msg: 'Logo actualizado.' };
  } catch (err) {
    console.error(err);
    req.session.flash = { type: 'error', msg: 'Error al subir el logo.' };
  }
  res.redirect('/admin/ajustes');
});

router.post('/ajustes/logo/eliminar', async (req, res) => {
  try {
    const current = await getSettings();
    if (current.logo_url) {
      try { await deleteImage(current.logo_url, current.logo_cloud_id); } catch (_) {}
    }
    await setSetting('logo_url', '');
    await setSetting('logo_cloud_id', '');
    req.session.flash = { type: 'success', msg: 'Logo eliminado. Se usará el predeterminado.' };
  } catch (err) {
    console.error(err);
    req.session.flash = { type: 'error', msg: 'Error al eliminar el logo.' };
  }
  res.redirect('/admin/ajustes');
});

router.post('/usuarios/:id/password', async (req, res) => {
  const { password, password2 } = req.body;
  if (!password || password.length < 8) {
    req.session.flash = { type: 'error', msg: 'La contraseña debe tener al menos 8 caracteres.' };
    return res.redirect('/admin/usuarios');
  }
  if (password !== password2) {
    req.session.flash = { type: 'error', msg: 'Las contraseñas no coinciden.' };
    return res.redirect('/admin/usuarios');
  }
  const hash = bcrypt.hashSync(password, 10);
  await run('UPDATE users SET password = ? WHERE id = ?', [hash, req.params.id]);
  req.session.flash = { type: 'success', msg: 'Contraseña actualizada.' };
  res.redirect('/admin/usuarios');
});

module.exports = router;
