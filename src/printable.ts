/** T105-H10: un mensaje de error puede traer texto de un paquete ajeno; los caracteres de control y de formato (ESC, OSC) no llegan a la terminal. */
export const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, c => /[\n\t]/.test(c) ? c : `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`);
