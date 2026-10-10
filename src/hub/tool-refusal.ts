/** A hub guard proved this request was refused before any task or board effect (screen telemetry is allowed). Never wrap arbitrary failures in this type. */
export class PreEffectToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreEffectToolRefusal";
  }
}
