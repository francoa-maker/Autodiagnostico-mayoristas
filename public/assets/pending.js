import { fetchJson } from "/assets/api.js";

async function refresh() {
  const { user } = await fetchJson("/api/me");
  if (!user) { location.href = "/login"; return; }
  document.getElementById("pendingEmail").textContent = user.email;
  if (user.status === "approved") location.href = "/";
}

refresh();
setInterval(refresh, 20000); // moderate auto-refresh, per catalog_design_spec.md
