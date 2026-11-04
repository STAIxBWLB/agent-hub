/**
 * #1053: the abort reason a transport gives when only the CLIENT of a waiting `hub_ask` is gone (Pi's bridge connection dropped), not the turn. The desk ends that wait
 * `pending` and keeps the row open, so a later answer takes the late-envelope path instead of going to a dead response; any other abort cancels the row (`turn_aborted`).
 * Its own file so an adapter can name it without importing the desk.
 */
export class QuestionWaitDetached extends Error { constructor() { super("the client of a waiting question went away"); this.name = "QuestionWaitDetached"; } }
