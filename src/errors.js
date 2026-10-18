export class RepropackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepropackError';
  }
}
