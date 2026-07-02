import { LightningElement, api } from 'lwc';

export default class ComplianceOfficerHome extends LightningElement {

    @api app_description = "Explore a Compliance Officer Role in PSC-LPI";
   
    @api app_welcome_text = "Learn how a Compliance Officer approves  an application and creates a Business License";

get pass_false() {
    return false;
}

get pass_true() {
    return true;
}

}