'use strict';
/* global walled */
const $ = (id) => document.getElementById(id);

function addEvent(e) {
  const empty = $('empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  const tag = document.createElement('span');
  const decision = e.decision || (e.type === 'error' ? 'error' : '');
  tag.className = 'tag ' + decision;
  tag.textContent = decision || e.type;
  const text = document.createElement('span');
  const time = new Date(e.time).toLocaleTimeString();
  text.textContent = e.type === 'error' ? `${time}  ${e.message}` : `${time}  ${e.site || ''} ${e.type}: ${e.detail || ''}`;
  li.append(tag, text);
  $('events').prepend(li);
}

walled.onEvent(addEvent);
walled.onStatus((s) => {
  $('dot').className = 'dot ' + s.state;
  $('status').textContent = s.text;
  if (s.color) $('swatch').style.background = s.color;
});
walled.getState().then((st) => {
  st.events.forEach(addEvent);
  $('marker').textContent = st.marker;
  $('swatch').style.background = st.color;
});

document.querySelectorAll('button[data-site]').forEach((b) => b.addEventListener('click', () => walled.openSite(b.dataset.site)));
$('recolor').addEventListener('change', (e) => walled.setRecolor(e.target.checked));
$('log').addEventListener('click', () => walled.openLog());
