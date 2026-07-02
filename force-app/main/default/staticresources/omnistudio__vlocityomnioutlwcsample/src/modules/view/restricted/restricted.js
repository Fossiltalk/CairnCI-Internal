import { api, LightningElement } from "lwc";

export default class Restricted extends LightningElement {
  /**
   * These attributes allow this view to be loaded by the omniscript-router component.
   */
  @api authenticated;
  @api connection;
  @api dir;
  @api inline;
  @api inlineLabel;
  @api inlineVariant;
  @api layout;
  @api prefill;
  @api runMode;
}
