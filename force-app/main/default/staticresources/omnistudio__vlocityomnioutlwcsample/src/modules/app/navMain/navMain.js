import { api, LightningElement } from "lwc";

export default class AppLayout extends LightningElement {
  @api authenticated = false;

  /**
   * Add more items here to add them to the navigation.
   */
  navBarItems = [
    {
      label: "My Cases",
      name: "my-cases",
    },
  ];

  @api updateNav() {
    this.template
      .querySelectorAll("app-nav-item")
      .forEach((item) => item.updateNav());
  }

  login() {
    this.dispatchEvent(new CustomEvent("login"));
  }

  logout() {
    this.dispatchEvent(new CustomEvent("logout"));
  }

  connectedCallback() {
    this.updateNav();
  }
}
