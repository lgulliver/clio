export type SourceSetupStatus = {
  ready: boolean;
  /** Local write or unresolved confirmation; accepted jobs and background reads are not busy. */
  busy: boolean;
  hasSavedResult: boolean;
};
export type SourceSetupPresentation = {
  step: 'configure' | 'collect';
  onStatus: (status: SourceSetupStatus) => void;
  onAccessLost: () => void;
};
