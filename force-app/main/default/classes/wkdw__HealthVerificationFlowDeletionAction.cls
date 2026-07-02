/*
This file is generated and isn't the actual source code for this
managed global class.
This read-only file shows the class's global constructors,
methods, variables, and properties.
To enable code to compile, all methods return null.
*/
global class HealthVerificationFlowDeletionAction {
    global HealthVerificationFlowDeletionAction() {

    }
    @InvocableMethod(label='Delete Draft Health Verification' description='Manages deletion of health verification in system context')
    global static List<wkdw.HealthVerificationFlowDeletionAction.RequestOutput> deleteDraftHealthVerification(List<wkdw.HealthVerificationFlowDeletionAction.RequestInput> requestInputs) {
        return null;
    }
global class RequestInput {
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
