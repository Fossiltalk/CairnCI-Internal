import { LightningElement , api} from 'lwc';

export default class ExploreLoyaltyProgramHome extends LightningElement {

   
    @api app_description = "Learn about PSC LPI Admin role and responsibilities";
   
    @api app_welcome_text = "Explore LPI Administration";

get pass_false() {
    return false;
} 

get pass_true() {
    return true;
}
}