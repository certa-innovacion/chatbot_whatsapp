const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../../scripts/peritoline_sync');
const { buildObservacionesEspecialesText } = _test;

describe('buildObservacionesEspecialesText', () => {
  test('si atiende el propio asegurado, fuerza Relación=Asegurado y AT. Perito=nombre del asegurado', () => {
    const row = {
      Asegurado: 'UNION FAM. MALACITANA DE INVER',
      Dirección: 'Avenida PRINCIPAL DEL CANDADO 5',
      CP: '29018',
      Municipio: 'Málaga',
      Teléfono: '34674742564',
      Relación: 'relacionado con la entidad',
      Daños: '360',
      Digital: 'Sí',
      Horario: 'mañana',
      'AT. Perito': 'yo - sin indicar - 34674742564',
    };

    const text = buildObservacionesEspecialesText(row);
    assert.match(text, /• Relación: Asegurado/);
    assert.match(text, /• AT\. Perito: UNION FAM\. MALACITANA DE INVER/);
  });

  test('si atiende otra persona, conserva relación y AT. Perito originales', () => {
    const row = {
      Asegurado: 'MARIA LOPEZ',
      Dirección: 'Calle Real 1',
      CP: '29001',
      Municipio: 'Málaga',
      Teléfono: '34600000000',
      Relación: 'Asegurada',
      Daños: '1500',
      Digital: 'No',
      Horario: '',
      'AT. Perito': 'Pedro López - hermano - 34611111111',
    };

    const text = buildObservacionesEspecialesText(row);
    assert.match(text, /• Relación: Asegurada/);
    assert.match(text, /• AT\. Perito: Pedro López/);
  });
});
