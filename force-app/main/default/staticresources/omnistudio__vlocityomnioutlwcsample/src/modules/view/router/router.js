import { api } from "lwc";
import Router from "c/router";
import { Connection } from "jsforce";

/**
 * Extend the base router component when you need to pass custom attributes to
 * a dynamic component.
 */
export default class ViewRouter extends Router {
  /**
   * Pass-thru attribute. Flag which is set to true, when the user successfully
   * authenticates. {@see app/main#constructor}
   * @type {boolean}
   */
  @api authenticated = false;

  /**
   * Pass-thru attribute. A jsForce connection object to be supplied
   * to child components.
   * @type {Connection}
   */
  @api connection;
  // @api get connection() {
  //   return this._connection;
  // }

  // set connection(value) {
  //   this._connection = value;
  //   this.routeChange();
  // }
}
