import { LightningElement, api } from 'lwc';

export default class InspectionsManagerHome extends LightningElement {

    @api app_description = "Explore Inspection Manager Role in PSC-LPI";
   
    @api app_welcome_text = "Learn how a Inspection Manager can setup action plan, inspection assessment and visit";

get pass_false() {
    return false;
}

get pass_true() {
    return true;
}


}