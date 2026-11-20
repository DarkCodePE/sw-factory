import { NOTE_ATTACHMENT_EXTENSIONS } from './note-attachments.ts';

export function noteForm(id: string, hidden: string, planned: boolean, remote: boolean): string {
  const attachment = remote
    ? '<p class="muted">El runner asignado es remoto. Puedes guardar una nota de texto.</p>'
    : `<label for="note-attachment">Adjunto de texto (opcional, máximo 64 KiB)</label>
<input id="note-attachment" type="file" name="attachment" accept="${NOTE_ATTACHMENT_EXTENSIONS.join(',')}" aria-describedby="note-attachment-help">
<p id="note-attachment-help" class="muted">Formatos: ${NOTE_ATTACHMENT_EXTENSIONS.join(', ')}. El próximo turno local confinado que pueda recibirlo enviará el archivo al proveedor del modelo como material de consulta.</p>`;
  return `<form action="/changes/${id}/note" method="post" enctype="multipart/form-data" class="web-action">${hidden}<fieldset>
<legend>Nota para el agente</legend><label for="note-body">Nota (máximo 8 KiB)</label>
<textarea id="note-body" name="body" rows="4" maxlength="8192" required></textarea>
${attachment}<button>Guardar nota</button><p class="muted">Guardar deja la nota pendiente para un turno de trabajo.${planned ? '' : ' Ahora no hay ningún turno previsto.'}</p>
</fieldset></form>`;
}
