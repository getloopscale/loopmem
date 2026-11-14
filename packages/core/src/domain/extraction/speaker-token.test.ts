import type { Tracer } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { restoreSpeakerToken } from './speaker-token.js';

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

const fix = (text: string, said: string): string => restoreSpeakerToken([{ text }], said, undefined)[0]?.text ?? '';

describe('restoreSpeakerToken', () => {
  it.each([
    ['o usuário é intolerante a glúten', 'Eu sou intolerante a glúten.', 'user é intolerante a glúten'],
    ['O usuário pratica esgrima.', 'Pratico esgrima.', 'user pratica esgrima.'],
    ['usuário fala suaíli', 'Eu falo suaíli.', 'user fala suaíli'],
    ['A tia do usuário, Ottoline, mora em Braga', 'Minha tia Ottoline mora em Braga.', 'A tia de user, Ottoline, mora em Braga'],
    ['O médico recomendou repouso ao usuário', 'O médico me recomendou repouso.', 'O médico recomendou repouso a user'],
    ['A usuária trabalha como contadora', 'Trabalho como contadora.', 'user trabalha como contadora'],
    ['El usuario guía una Bianchina', 'Guido una Bianchina.', 'user guía una Bianchina'],
    ['El coche del usuario es rojo', 'Mi coche es rojo.', 'El coche de user es rojo'],
    ["La fille de l'utilisateur, Capucine, fait du violon.", 'Ma fille Capucine fait du violon.', 'La fille de user, Capucine, fait du violon.'],
    ["L'utilisatrice habite à Lyon", "J'habite à Lyon.", 'user habite à Lyon'],
    ["L'utente guida una Bianchina", 'Guido una Bianchina.', 'user guida una Bianchina'],
    ["La sorella dell'utente vive a Pisa", 'Mia sorella vive a Pisa.', 'La sorella di user vive a Pisa'],
    ['Der Benutzer wohnt in Kiel', 'Ich wohne in Kiel.', 'user wohnt in Kiel'],
    ['Die Schwester des Nutzers wohnt in Kiel', 'Meine Schwester wohnt in Kiel.', 'Die Schwester von user wohnt in Kiel'],
    ['The user supports Porto Sereno FC.', 'I support Porto Sereno FC.', 'user supports Porto Sereno FC.'],
    ["User's phone is a Fairphone 5", 'My phone is a Fairphone 5.', "user's phone is a Fairphone 5"],
  ])('writes the speaker as the token: %s', (stored, said, expected) => {
    expect(fix(stored, said)).toBe(expected);
  });

  it('leaves the word alone when the message itself uses it', () => {
    expect(fix('O usuário do aplicativo pode redefinir a senha', 'No meu app, o usuário pode redefinir a senha.')).toBe('O usuário do aplicativo pode redefinir a senha');
    expect(fix('The user can reset the password from the login page', 'In our app the user can reset the password from the login page.')).toBe('The user can reset the password from the login page');
  });

  it('leaves a fact that already has the token as it is', () => {
    expect(fix('user drives a Polestar', 'I drive a Polestar.')).toBe('user drives a Polestar');
    expect(fix("user's aunt Ottoline lives in Braga", 'My aunt Ottoline lives in Braga.')).toBe("user's aunt Ottoline lives in Braga");
  });

  it('does not touch a longer word that contains one of the speaker words', () => {
    expect(fix('user gosta de testes com usuários reais', 'Gosto de testes com gente real.')).toBe('user gosta de testes com usuários reais');
    expect(fix('user is a superuser on the forum', 'I am an admin on the forum.')).toBe('user is a superuser on the forum');
  });

  it('reports how many facts were rewritten', () => {
    const events: Recorded[] = [];
    restoreSpeakerToken([{ text: 'o usuário pratica squash' }, { text: 'user fala suaíli' }], 'Pratico squash e falo suaíli.', recordingTracer(events));
    expect(events).toEqual([{ event: 'extraction_speaker_token_restored', attributes: { restored: 1 } }]);
  });

  it('reports nothing when no fact changed', () => {
    const events: Recorded[] = [];
    restoreSpeakerToken([{ text: 'user fala suaíli' }], 'Falo suaíli.', recordingTracer(events));
    expect(events).toEqual([]);
  });
});
