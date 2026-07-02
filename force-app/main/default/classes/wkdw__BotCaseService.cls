/*
This file is generated and isn't the actual source code for this
managed global class.
This read-only file shows the class's global constructors,
methods, variables, and properties.
To enable code to compile, all methods return null.
*/
global class BotCaseService {
    @InvocableMethod(label='Find Case Record from Case Number' description='Returns the case record associated to the case number')
    global static List<String> findCaseRecord(List<wkdw.BotCaseService.FindRequest> findRequest) {
        return null;
    }
global class FindRequest {
    @InvocableVariable( required=false)
    global String caseNumber;
    @InvocableVariable( required=false)
    global String employeeId;
    global FindRequest() {

    }
}
}
