// Muestra el mensaje de error de login (?error=...) fuera de línea para que la
// CSP pueda usar script-src 'self' sin 'unsafe-inline'.
const messages = {
  google_not_configured: "Faltan cargar las credenciales de Google en el servidor.",
  missing_code: "Google no devolvió el código de acceso.",
  token_failed: "No se pudo validar el acceso con Google.",
  profile_failed: "No se pudo leer el perfil de Google.",
  invalid_state: "La sesión de login venció. Volvé a intentar."
};
const error = new URLSearchParams(location.search).get("error");
if (error) {
  const el = document.getElementById("loginError");
  el.textContent = messages[error] || "No se pudo iniciar sesión.";
  el.classList.add("visible");
}
