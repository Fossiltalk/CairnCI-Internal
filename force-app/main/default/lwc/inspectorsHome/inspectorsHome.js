import { LightningElement, api } from 'lwc';

export default class InspectorsHome extends LightningElement {
    @api app_description = "Explore a Inspector Role in PSC-LPI";
   
    @api app_welcome_text = "Learn how a Inspector executes the Inspection in PS Inspection App";

get pass_false() {
    return false;
}

get pass_true() {
    return true;
}

}