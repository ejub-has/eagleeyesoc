// Applies a saved Light or Dark choice before first paint; "System" leaves the OS setting in charge.
try {
  const choice = localStorage.getItem('casemgr.theme')
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice
} catch {
  // Storage can be blocked; the system theme still applies.
}
