/** A hub guard proved this request was refused before any effect. Never wrap arbitrary failures in this type. */
export class PreEffectToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreEffectToolRefusal";
  }
}
