export const manifest = {
  manifest_version: 3,
  name: 'FormPilot',
  version: '0.1.0',
  minimum_chrome_version: '120',
  description: 'FormPilot M2：本地资料库与网页表单扫描',
  permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
  host_permissions: ['http://127.0.0.1/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_popup: 'popup.html', default_title: 'FormPilot' },
  options_ui: { page: 'options.html', open_in_tab: true },
  side_panel: { default_path: 'sidepanel.html' },
  externally_connectable: { matches: ['http://localhost/*'] },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'",
  },
};
