import { describe, expect, it } from 'vitest';

import { namesIn, nameSetsDiffer } from './name-difference.js';

describe('namesIn', () => {
  it('reads each run of capitalised words as one name, in lower case', () => {
    expect([...namesIn("user's aunt Ottoline is insured with Castlegate Care")].sort()).toEqual(['castlegate care', 'ottoline']);
    expect([...namesIn('O mecânico de user é o Seu Nicanor')].sort()).toEqual(['seu nicanor']);
  });

  it('keeps a title with its name and drops a possessive ending', () => {
    expect([...namesIn("Dr. Lindgren is Wilhelmina's vet")].sort()).toEqual(['dr. lindgren', 'wilhelmina']);
  });

  it('joins the parts of a name across a connecting word and drops one left at the end', () => {
    expect([...namesIn('user takes the car to Ines at Apex Motors')]).toEqual(['ines at apex motors']);
    expect([...namesIn('Fernanda da Silva mora em Braga')].sort()).toEqual(['braga', 'fernanda da silva']);
  });

  it('does not count the speaker token or a leading article', () => {
    expect([...namesIn('The user lives in Leeds')]).toEqual(['leeds']);
    expect([...namesIn('user works at night')]).toEqual([]);
  });
});

describe('nameSetsDiffer', () => {
  it('is true when each note has names the other lacks, in different numbers', () => {
    expect(nameSetsDiffer("user's insurer is Vida Plena", "user's aunt Ottoline's insurer is Unimais")).toBe(true);
    expect(nameSetsDiffer('Raj at Kerbside Autos is the mechanic for Baltazar', "user's car mechanic is Seu Nicanor")).toBe(true);
  });

  it('is false when one value was swapped for another', () => {
    expect(nameSetsDiffer("user's insurer is Vida Plena", "user's insurer is Unimais")).toBe(false);
    expect(nameSetsDiffer("user's aunt Ottoline's insurer is Vida Plena", "user's aunt Ottoline is insured with Unimais")).toBe(false);
  });

  it('is false when one of the notes has no name of its own', () => {
    expect(nameSetsDiffer('user lives in Lyon, not Paris', 'user lives in Paris')).toBe(false);
    expect(nameSetsDiffer('user is vegetarian', 'user eats fish with Ottoline')).toBe(false);
  });
});
