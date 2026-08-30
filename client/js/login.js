// Aucune donnée d'identification n'est jamais stockée ni comparée ici : ce script se contente de
// transmettre le formulaire au serveur (seul endroit où le mot de passe est vérifié, via bcrypt).
const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Échec de connexion');
    document.getElementById('login-password').value = '';
    const params = new URLSearchParams(location.search);
    location.href = params.get('next') || 'index.html';
  } catch (err) {
    errorEl.textContent = err.message;
    document.getElementById('login-password').value = '';
    submitBtn.disabled = false;
  }
});
