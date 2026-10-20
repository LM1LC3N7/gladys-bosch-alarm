// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

export const DEVICE_NAMES = {
  panel: { fr: 'Centrale Bosch', en: 'Bosch panel' },
  area: { fr: (n) => `Secteur ${n}`, en: (n) => `Area ${n}` },
  point: { fr: (n) => `Point ${n}`, en: (n) => `Point ${n}` },
  output: { fr: (n) => `Sortie ${n}`, en: (n) => `Output ${n}` },
};

export const FEATURE_NAMES = {
  online: { fr: 'Centrale connectée', en: 'Panel connected' },
  trouble: { fr: 'Défaut en cours', en: 'Trouble' },
  'ac-failure': { fr: 'Coupure secteur', en: 'AC power failure' },
  'battery-low': { fr: 'Batterie faible ou absente', en: 'Battery low or missing' },
  mode: { fr: 'État', en: 'State' },
  armed: { fr: 'Armé', en: 'Armed' },
  ready: { fr: 'Prêt à armer', en: 'Ready to arm' },
  alarm: { fr: 'Alarme en cours', en: 'Alarm in progress' },
  'fire-alarm': { fr: 'Mémoire alarme incendie', en: 'Fire alarm memory' },
  'arm-away': { fr: 'Armement total', en: 'Arm away' },
  'arm-stay': { fr: 'Armement partiel', en: 'Arm stay' },
  disarm: { fr: 'Désarmer', en: 'Disarm' },
  kind: {
    opening: { fr: 'Ouverture', en: 'Opening' },
    motion: { fr: 'Mouvement', en: 'Motion' },
    smoke: { fr: 'Fumée', en: 'Smoke' },
    leak: { fr: "Fuite d'eau", en: 'Water leak' },
  },
  state: { fr: 'Active', en: 'On' },
  'turn-on': { fr: 'Activer', en: 'Turn on' },
  'turn-off': { fr: 'Désactiver', en: 'Turn off' },
};

/** The text of the read-only state feature of an area. */
export const MODE_NAMES = {
  disarmed: { fr: 'Désarmé', en: 'Disarmed' },
  arming: { fr: 'Armement en cours', en: 'Arming' },
  pending: { fr: "Temporisation d'entrée", en: 'Entry delay' },
  armed_away: { fr: 'Armé (total)', en: 'Armed (away)' },
  armed_stay: { fr: 'Armé (partiel)', en: 'Armed (stay)' },
};

const modeList = (areas, language) => {
  if (areas.length === 0) return '';
  const shown = areas
    .slice(0, 8)
    .map(({ area, mode }) =>
      mode ? `${area}: ${word(MODE_NAMES[mode], language).toLowerCase()}` : `${area}: ?`,
    );
  if (areas.length > 8) shown.push('…');
  return ` (${shown.join(', ')})`;
};

const nothing = { fr: " : rien n'a été envoyé.", en: ': nothing was sent.' };

const retryText = {
  en: ' Change a code in the configuration, or click "Allow a new try of the code".',
  fr: ' Changez un code dans la configuration, ou cliquez sur « Autoriser un nouvel essai du code ».',
};

/** Connection status and command messages. */
export const T = {
  noHost: {
    en: 'Enter the address of the Bosch panel in the configuration.',
    fr: "Saisissez l'adresse de la centrale Bosch dans la configuration.",
  },
  noCode: {
    en: 'Enter the automation code (B and G series, AMAX) or the user code (Solution) in the configuration.',
    fr: "Saisissez le code d'automatisation (séries B et G, AMAX) ou le code utilisateur (Solution) dans la configuration.",
  },
  badAutomationCode: {
    en: 'The automation code holds 1 to 32 characters (letters, digits, signs, no space): fix it.',
    fr: "Le code d'automatisation compte 1 à 32 caractères (lettres, chiffres, signes, sans espace) : corrigez-le.",
  },
  badUserCode: {
    en: 'The user or installer code holds 1 to 8 digits: fix it.',
    fr: 'Le code utilisateur ou installateur compte 1 à 8 chiffres : corrigez-le.',
  },
  needUserCode: {
    en: 'Solution panels need the user code (the automation code is not used): enter it in the configuration.',
    fr: "Les centrales Solution demandent le code utilisateur (le code d'automatisation n'est pas utilisé) : saisissez-le dans la configuration.",
  },
  needBothCodes: {
    en: 'AMAX panels need the automation code and the installer code: enter both in the configuration.',
    fr: "Les centrales AMAX demandent le code d'automatisation et le code installateur : saisissez les deux dans la configuration.",
  },
  needAutomationCode: {
    en: 'B and G series panels need the automation code (the user code is not used): enter it in the configuration.',
    fr: "Les centrales des séries B et G demandent le code d'automatisation (le code utilisateur n'est pas utilisé) : saisissez-le dans la configuration.",
  },
  connecting: { en: 'Connecting to the Bosch panel…', fr: 'Connexion à la centrale Bosch…' },
  connected: {
    en: (model, areas, points, outputs) =>
      `Connected to the ${model} panel, area(s)${modeList(areas, 'en')}, ${points} point(s), ${outputs} output(s).`,
    fr: (model, areas, points, outputs) =>
      `Connecté à la centrale ${model}, secteur(s)${modeList(areas, 'fr')}, ${points} point(s), ${outputs} sortie(s).`,
  },
  codeStopped: {
    en: `The panel refused the code at login: the integration stopped and will not try it again by itself.${retryText.en}`,
    fr: `La centrale a refusé le code à la connexion : l'intégration s'est arrêtée et ne le réessaiera pas d'elle-même.${retryText.fr}`,
  },
  unreachable: {
    en: (reason, seconds) => `Bosch panel unreachable (${reason}), next try in ${seconds} s.`,
    fr: (reason, seconds) =>
      `Centrale Bosch injoignable (${reason}), nouvel essai dans ${seconds} s.`,
  },
  busy: {
    en: (seconds) =>
      `The panel has no free automation connection (another software uses it: Home Assistant, a second Gladys…). Next try in ${seconds} s.`,
    fr: (seconds) =>
      `La centrale n'a plus de connexion d'automatisation libre (un autre logiciel l'utilise : Home Assistant, un second Gladys…). Nouvel essai dans ${seconds} s.`,
  },
  offline: {
    en: `The panel is not connected${nothing.en}`,
    fr: `La centrale n'est pas connectée${nothing.fr}`,
  },
  disarmRefused: {
    en: `Disarming from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Le désarmement depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  lowerRefused: {
    en: `Going from armed away to armed stay lowers the protection, like a disarm, and disarming from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Passer d'armé total à armé partiel baisse la protection, comme un désarmement, et le désarmement depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  outputsRefused: {
    en: `Controlling outputs from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Le pilotage des sorties depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  entryDelay: {
    en: `The area is armed and its entry delay is running (someone came in)${nothing.en}`,
    fr: `Le secteur est armé et sa temporisation d'entrée est en cours (quelqu'un est entré)${nothing.fr}`,
  },
  unknownArea: {
    en: (n) => `Area ${n} is not on the panel${nothing.en}`,
    fr: (n) => `Le secteur ${n} n'existe pas sur la centrale${nothing.fr}`,
  },
  unknownOutput: {
    en: (n) => `Output ${n} is not on the panel, or cannot be controlled${nothing.en}`,
    fr: (n) =>
      `La sortie ${n} n'existe pas sur la centrale, ou ne peut pas être pilotée${nothing.fr}`,
  },
  stateUnknown: {
    en: `The current state could not be read from the panel${nothing.en}`,
    fr: `L'état actuel n'a pas pu être relu sur la centrale${nothing.fr}`,
  },
  tooLate: {
    en: `The panel answered too slowly to send the command in time${nothing.en}`,
    fr: `La centrale a répondu trop lentement pour envoyer la commande à temps${nothing.fr}`,
  },
  noAccess: {
    en: (what) =>
      `The panel refused the command: the automation user has no right for it (${what}).`,
    fr: (what) =>
      `La centrale a refusé la commande : l'utilisateur d'automatisation n'en a pas le droit (${what}).`,
  },
  cannotArm: {
    en: (what) =>
      `The panel cannot arm now (${what}): a point is open or a trouble is in progress.`,
    fr: (what) =>
      `La centrale ne peut pas armer maintenant (${what}) : un point est ouvert ou un défaut est en cours.`,
  },
  panelRefused: {
    en: (what, why) => `The panel refused the command (${what}: ${why}).`,
    fr: (what, why) => `La centrale a refusé la commande (${what} : ${why}).`,
  },
  unconfirmed: {
    en: (what) =>
      `Sent to the panel (${what}), without confirmation in time: the state is read again in 2 s.`,
    fr: (what) =>
      `Envoyé à la centrale (${what}), sans confirmation dans les temps : l'état est relu dans 2 s.`,
  },
  commandBusy: {
    en: `Other commands took all the time of this one before its turn came${nothing.en}`,
    fr: `D'autres commandes ont pris tout le temps de celle-ci avant son tour${nothing.fr}`,
  },
  disarmWithdrawn: {
    en: `An arming of this area was asked while this disarm waited its turn${nothing.en}`,
    fr: `Un armement de ce secteur a été demandé pendant que ce désarmement attendait son tour${nothing.fr}`,
  },
  codeNotStopped: {
    en: 'The codes are not stopped: nothing to allow.',
    fr: 'Les codes ne sont pas arrêtés : rien à autoriser.',
  },
  codeRetryAllowed: {
    en: 'The integration logs in again now, once, with the codes of the configuration.',
    fr: "L'intégration se reconnecte maintenant, une fois, avec les codes de la configuration.",
  },
  codeStoppedTest: {
    en: `The panel refused the code before: nothing was sent.${retryText.en}`,
    fr: `La centrale a déjà refusé le code : rien n'a été envoyé.${retryText.fr}`,
  },
  stillConnecting: {
    en: 'The connection to the panel is still starting; try again in a moment.',
    fr: 'La connexion à la centrale démarre encore ; réessayez dans un instant.',
  },
};

/** What a command does, for the logs and the messages. */
export const COMMAND_NAMES = {
  armed_away: {
    en: (a) => `arm away, area ${a}`,
    fr: (a) => `armement total, secteur ${a}`,
  },
  armed_stay: {
    en: (a) => `arm stay, area ${a}`,
    fr: (a) => `armement partiel, secteur ${a}`,
  },
  disarm: { en: (a) => `disarm, area ${a}`, fr: (a) => `désarmement, secteur ${a}` },
  'turn-on': { en: (o) => `turn on, output ${o}`, fr: (o) => `activation, sortie ${o}` },
  'turn-off': { en: (o) => `turn off, output ${o}`, fr: (o) => `désactivation, sortie ${o}` },
};
