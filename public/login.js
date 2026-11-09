$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button');
  $('#err').textContent = '';
  btn.disabled = true;
  try {
    await api.send('POST', '/api/login', { username: f.username.value.trim(), password: f.password.value });
    const next = new URLSearchParams(location.search).get('next') || '/';
    // only follow same-site paths
    location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  } catch (err) {
    $('#err').textContent = err.message;
    f.password.value = '';
    f.password.focus();
  } finally {
    btn.disabled = false;
  }
});
