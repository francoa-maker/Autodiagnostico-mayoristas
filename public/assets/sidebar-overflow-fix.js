const STYLE_ID = "sidebar-overflow-fix";

function installSidebarOverflowFix() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    body.v5-admin {
      max-width: 100vw;
      overflow-x: hidden !important;
    }
    body.v5-admin .admin-app,
    body.v5-admin .admin-main {
      min-width: 0;
      max-width: 100%;
    }
    body.v5-admin .admin-sidebar {
      box-sizing: border-box;
      max-width: 100vw;
      overflow-x: hidden !important;
      overscroll-behavior-x: none;
    }
    body.v5-admin .admin-sidebar > *,
    body.v5-admin .admin-brand-copy,
    body.v5-admin .admin-workspace > div,
    body.v5-admin .admin-global-search,
    body.v5-admin .admin-nav,
    body.v5-admin .v5-admin-nav {
      min-width: 0;
      max-width: 100%;
    }
    body.v5-admin .admin-user {
      width: 100%;
      display: grid !important;
      grid-template-columns: 32px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
    }
    body.v5-admin .admin-user .av,
    body.v5-admin .admin-user > div:not(.av),
    body.v5-admin .admin-user a {
      display: block !important;
    }
    body.v5-admin .admin-user > div:not(.av) {
      min-width: 0;
      overflow: hidden;
    }
    body.v5-admin .admin-user strong,
    body.v5-admin .admin-user span {
      display: block;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    body.v5-admin .admin-user a {
      flex-shrink: 0;
      white-space: nowrap;
    }
    @media (max-width: 1023px) {
      body.v5-admin .admin-sidebar {
        width: min(var(--sidebar-w), calc(100vw - 8px));
        max-width: calc(100vw - 8px);
      }
      body.v5-admin.v5-menu-open {
        overflow-x: hidden !important;
      }
    }
  `;
  document.head.appendChild(style);
}

installSidebarOverflowFix();
