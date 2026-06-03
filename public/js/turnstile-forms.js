/*
 * Cars & Campers — Turnstile en modo "popup al enviar"
 *
 * Patrón:
 * 1. El widget <div class="cf-turnstile"> está oculto por defecto
 *    (data-execution="execute" data-appearance="interaction-only").
 * 2. Cuando el usuario pulsa "Enviar", interceptamos el submit y
 *    llamamos a turnstile.execute() → Cloudflare muestra el reto
 *    si lo necesita, o pasa silenciosamente si lo considera seguro.
 * 3. Cuando Cloudflare emite el token (callback), lo metemos en un
 *    hidden input y enviamos el form de verdad.
 * 4. Si falla (error-callback), reactivamos el botón y avisamos.
 */
(function () {
  // Solo si hay widgets en la página
  const widgets = document.querySelectorAll('.cf-turnstile');
  if (!widgets.length) return;

  // Una variable global por página: el form que está esperando token
  let pendingForm = null;
  let pendingBtn  = null;
  let pendingBtnText = '';

  // ── Callbacks que Turnstile invoca por data-callback ──────────
  window.onTurnstileSuccess = function (token) {
    if (!pendingForm) return;
    // Inyectar el token en el form
    let input = pendingForm.querySelector('input[name="cf-turnstile-response"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      pendingForm.appendChild(input);
    }
    input.value = token;
    pendingForm._turnstileValid = true;
    pendingForm.submit();
  };

  window.onTurnstileError = function () {
    if (!pendingForm) return;
    pendingForm._turnstileValid = false;
    restoreBtn();
    pendingForm = null;
    alert('No pudimos verificar que eres humano. Por favor, recarga la página e inténtalo de nuevo.');
  };

  window.onTurnstileExpired = function () {
    if (pendingForm) {
      pendingForm._turnstileValid = false;
      restoreBtn();
      pendingForm = null;
    }
  };

  function restoreBtn() {
    if (pendingBtn) {
      pendingBtn.disabled = false;
      if (pendingBtnText) pendingBtn.textContent = pendingBtnText;
    }
  }

  // ── Interceptar submit de cada form con widget ────────────────
  widgets.forEach(widget => {
    const form = widget.closest('form');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      // Si ya pasamos por aquí y tenemos token, dejar pasar
      if (form._turnstileValid) return;

      e.preventDefault();
      if (!window.turnstile) {
        alert('La verificación aún está cargando. Espera un par de segundos y vuelve a pulsar Enviar.');
        return;
      }

      pendingForm = form;
      // Deshabilitar botón mientras se procesa
      pendingBtn = form.querySelector('button[type="submit"]');
      if (pendingBtn) {
        pendingBtnText = pendingBtn.textContent;
        pendingBtn.disabled = true;
        pendingBtn.textContent = 'Verificando…';
      }
      // Disparar el reto de Turnstile (muestra popup si necesita)
      window.turnstile.execute(widget);
    });
  });
})();
