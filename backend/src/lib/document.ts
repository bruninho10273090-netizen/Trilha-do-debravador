/** Valida CPF (11 dígitos) ou CNPJ (14 dígitos) pelos dígitos verificadores. Devolve só os números, ou null. */
export function normalizeCpfCnpj(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (/^(\d)\1+$/.test(d)) return null;
  if (d.length === 11) return cpfOk(d) ? d : null;
  if (d.length === 14) return cnpjOk(d) ? d : null;
  return null;
}

function cpfOk(d: string) {
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

function cnpjOk(d: string) {
  const digit = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((s, x, i) => s + x * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}
