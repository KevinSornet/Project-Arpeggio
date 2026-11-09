function nextPage() {
  const next = new URLSearchParams(location.search).get('next') || 'index.html';
  // only follow plain page names on this site (no other websites)
  return /^[a-z]+\.html(\?.*)?$/i.test(next) ? next : 'index.html';
}

if (DEMO) {
  $('#demoBox').hidden = false;
  demoBackend().then(b => {
    $('#demoAccounts').innerHTML = b.accounts.map(a =>
      `<button type="button" class="demo-acct" data-u="${esc(a.username)}" data-p="${esc(a.password)}">
        <b>${esc(a.username)}</b><span class="muted">${ROLE_LABEL[a.role]}${a.dealer ? ' · ' + esc(a.dealer) : ''}</span></button>`).join('');
  });
  $('#demoAccounts').addEventListener('click', e => {
    const b = e.target.closest('.demo-acct');
    if (!b) return;
    $('#loginForm').username.value = b.dataset.u;
    $('#loginForm').password.value = b.dataset.p;
    $('#loginForm').requestSubmit();
  });
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button[type=submit]');
  $('#err').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await api.call('login', { username: f.username.value.trim(), password: f.password.value });
    setToken(res.token);
    location.href = nextPage();
  } catch (err) {
    $('#err').textContent = err.message;
    f.password.value = '';
    f.password.focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
