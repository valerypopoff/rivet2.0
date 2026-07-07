declare module 'dictionary-en' {
  const dictionary: {
    aff: Buffer | string;
    dic: Buffer | string;
  };

  export default dictionary;
}

declare module 'rivet-cspell-words' {
  const words: string[];

  export default words;
}
