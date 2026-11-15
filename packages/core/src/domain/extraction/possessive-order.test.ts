import type { Tracer } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { restorePossessiveOrder } from './possessive-order.js';

interface Recorded { event: string; attributes: Record<string, unknown> }

function recordingTracer(sink: Recorded[]): Tracer {
  return {
    startActiveSpan(name: string, fn: (span: unknown) => void): void {
      const attributes: Record<string, unknown> = {};
      fn({ setAttribute: (k: string, v: unknown) => { attributes[k] = v; }, end: () => undefined });
      sink.push({ event: name, attributes });
    },
  } as unknown as Tracer;
}

const fix = (text: string, said: string): string => restorePossessiveOrder([{ text }], said, undefined)[0]?.text ?? '';

describe('restorePossessiveOrder', () => {
  it.each([
    ['user pai se aposentou em março', 'Meu pai se aposentou em março.', 'O pai de user se aposentou em março'],
    ['user avó mora em Braga', 'A minha avó mora em Braga.', 'A avó de user mora em Braga'],
    ['user filhos estudam à tarde', 'Meus filhos estudam à tarde.', 'Os filhos de user estudam à tarde'],
    ['user primas moram em Recife', 'Minhas primas moram em Recife.', 'As primas de user moram em Recife'],
    ['user meio-irmão leva o carro ao mecânico', 'Meu meio-irmão leva o carro ao mecânico.', 'O meio-irmão de user leva o carro ao mecânico'],
    ['user provedor é a Onda Móvel', 'Meu provedor é a Onda Móvel.', 'O provedor de user é a Onda Móvel'],
    ['user provedor de internet é a Corvid Telecom', 'Meu provedor de internet é a Corvid Telecom.', 'O provedor de internet de user é a Corvid Telecom'],
    ['user plano de saúde é da Vida Plena', 'Meu plano de saúde é da Vida Plena.', 'O plano de saúde de user é da Vida Plena'],
  ])('puts the noun before the owner: %s', (stored, said, expected) => {
    expect(fix(stored, said)).toBe(expected);
  });

  it('sets a name that follows the noun between commas', () => {
    expect(fix('user filho Davi não gosta de futebol', 'Meu filho Davi não gosta de futebol.')).toBe('O filho de user, Davi, não gosta de futebol');
    expect(fix('user irmã Ana Clara mora em Braga', 'Minha irmã Ana Clara mora em Braga.')).toBe('A irmã de user, Ana Clara, mora em Braga');
  });

  it('leaves a fact whose second word is not a noun the message gives a possessive to', () => {
    expect(fix('user mora em Braga', 'Moro em Braga com minha irmã.')).toBe('user mora em Braga');
    expect(fix('user tem dois gatos', 'Tenho dois gatos.')).toBe('user tem dois gatos');
    expect(fix("user's sister lives in Leeds", 'My sister lives in Leeds.')).toBe("user's sister lives in Leeds");
  });

  it('leaves a short word alone, since after a possessive it is usually a verb with the noun left out', () => {
    expect(fix('user é mais barato', 'O plano dele é caro, o meu é mais barato.')).toBe('user é mais barato');
  });

  it('leaves a fact that is already in order', () => {
    expect(fix('O pai de user mora em Campinas', 'Meu pai mora em Campinas.')).toBe('O pai de user mora em Campinas');
  });

  it('reports how many facts were rewritten, and nothing when none was', () => {
    const events: Recorded[] = [];
    restorePossessiveOrder([{ text: 'user pai se aposentou' }, { text: 'user mora em Braga' }], 'Meu pai se aposentou. Moro em Braga.', recordingTracer(events));
    restorePossessiveOrder([{ text: 'user mora em Braga' }], 'Moro em Braga.', recordingTracer(events));
    expect(events).toEqual([{ event: 'extraction_possessive_order_restored', attributes: { restored: 1 } }]);
  });
});
