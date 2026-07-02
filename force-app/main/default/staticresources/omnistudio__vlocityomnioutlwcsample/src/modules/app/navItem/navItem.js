import { api, LightningElement } from "lwc";
import { pageReferenceTypes } from "c/navigationUtils";
export default class NavItem extends LightningElement {
  @api type = pageReferenceTypes.NAVIGATION_ITEM;
  @api name;
  @api label;

  classes;

  @api updateNav() {
    this.classes =
      location.pathname.indexOf(this.name) > -1
        ? "slds-pill slds-pill_link"
        : "";
  }

  connectedCallback() {
    this.updateNav();
  }
}
