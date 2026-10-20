const setupForm = document.querySelector('#setup-form');
const setupMessage = document.querySelector('#setup-message');
const setupButton = document.querySelector('#setup-submit');

fetch('/api/setup-status')
  .then(async (response) => {
    if (!response.ok) throw new Error('Could not check owner setup status.');
    return response.json();
  })
  .then((status) => {
    if (!status.setupConfigured || status.ownerExists) {
      setupForm.querySelectorAll('input, button').forEach((field) => { field.disabled = true; });
      setupMessage.textContent = status.ownerExists
        ? 'Owner setup is already complete. Sign in from the main page.'
        : 'Owner setup is disabled until the server has an OWNER_SETUP_TOKEN configured.';
    }
  })
  .catch((error) => {
    setupForm.querySelectorAll('input, button').forEach((field) => { field.disabled = true; });
    setupMessage.textContent = error.message;
  });

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setupMessage.textContent = '';
  setupButton.disabled = true;
  try {
    const response = await fetch('/api/setup-owner', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupToken: document.querySelector('#setup-token').value,
        name: document.querySelector('#owner-name').value.trim(),
        shopName: document.querySelector('#shop-name').value.trim(),
        username: document.querySelector('#owner-username').value.trim(),
        password: document.querySelector('#owner-password').value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not create the owner account.');
    window.location.assign('/');
  } catch (error) {
    setupMessage.textContent = error.message;
  } finally {
    setupButton.disabled = false;
  }
});
