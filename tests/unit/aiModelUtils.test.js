const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../../src/ai/aiModel');
const { isJsonParseError, parseModelJsonResponse } = _test;

describe('parseModelJsonResponse', () => {
  test('parsea JSON puro', () => {
    const out = parseModelJsonResponse('{"mensaje_para_usuario":"ok","mensaje_entendido":true,"datos_extraidos":{}}');
    assert.equal(out.mensaje_para_usuario, 'ok');
    assert.equal(out.mensaje_entendido, true);
  });

  test('parsea JSON dentro de bloque markdown', () => {
    const out = parseModelJsonResponse('```json\n{"mensaje_para_usuario":"hola","mensaje_entendido":true,"datos_extraidos":{}}\n```');
    assert.equal(out.mensaje_para_usuario, 'hola');
  });

  test('parsea JSON con texto envolvente', () => {
    const out = parseModelJsonResponse('Respuesta:\n{"mensaje_para_usuario":"vale","mensaje_entendido":true,"datos_extraidos":{}}\nGracias');
    assert.equal(out.mensaje_para_usuario, 'vale');
  });

  test('lanza error con JSON truncado', () => {
    assert.throws(
      () => parseModelJsonResponse('{"mensaje_para_usuario":"hola"'),
      /SyntaxError|JSON|No se pudo parsear JSON/
    );
  });
});

describe('isJsonParseError', () => {
  test('detecta SyntaxError como parse error', () => {
    assert.equal(isJsonParseError(new SyntaxError('Unexpected end of JSON input')), true);
  });

  test('no marca errores genéricos no JSON', () => {
    assert.equal(isJsonParseError(new Error('network timeout')), false);
  });
});
