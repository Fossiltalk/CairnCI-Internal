import { LightningElement, api } from 'lwc';

export default class IntakeOfficerHome extends LightningElement {
    @api app_description = "Explore Intake Officers in PSC LPI";
   
    @api app_welcome_text = "Explore the Intake Officer Roles in PSC LPI";

get pass_false() {
    return false;
}

get pass_true() {
    return true;
}

}