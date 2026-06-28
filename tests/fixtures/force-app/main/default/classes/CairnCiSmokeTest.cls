/**
 * Gives the fixture 100% Apex coverage so CairnCI's coverage gate has something
 * meaningful to measure during a RunLocalTests validation.
 */
@isTest
private class CairnCiSmokeTest {
    @isTest
    static void returnsAnswer() {
        System.assertEquals(42, CairnCiSmoke.answer(), 'unexpected answer');
    }
}
