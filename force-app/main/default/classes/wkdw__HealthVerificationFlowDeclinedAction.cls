/*
This file is generated and isn't the actual source code for this
managed global class.
This read-only file shows the class's global constructors,
methods, variables, and properties.
To enable code to compile, all methods return null.
*/
global class HealthVerificationFlowDeclinedAction {
    global HealthVerificationFlowDeclinedAction() {

    }
    @InvocableMethod(label='Promote Declined Health Verification' description='Manages appropriate Health Verification update to make it declined')
    global static List<wkdw.HealthVerificationFlowDeclinedAction.RequestOutput> promoteDeclinedHealthVerification(List<wkdw.HealthVerificationFlowDeclinedAction.RequestInput> requestInputs) {
        return null;
    }
global class RequestInput {
    @InvocableVariable( required=false)
    global String declinationReason;
    @InvocableVariable( required=false)
    global String draftHealthVerificationId;
    global RequestInput() {

    }
}
global class RequestOutput {
    @InvocableVariable( required=false)
    global String errorMessage;
    @InvocableVariable( required=false)
    global Boolean isSuccess;
}
}
