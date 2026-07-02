import { LightningElement, api } from "lwc";
export default class HomePage extends LightningElement {
    @api authenticated;
    @api connection;
}
