Feature: Order status management

  @happy_path
  Scenario: Submit DRAFT order
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in DRAFT status with one item
    When I submit the order via the UI
    Then the order status should be SUBMITTED
    And the order status history should contain entries DRAFT, SUBMITTED in order

  @edge_case
  Scenario: Delete SUBMITTED order via UI
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in SUBMITTED status with one item
    When I view the orders page
    Then the order row should not show a Delete button

  @edge_case
  Scenario: Delete SUBMITTED order via API
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in SUBMITTED status with one item
    When I send a DELETE request for the order via API
    Then the API response status should be 409
    And the API response body should contain message "Cannot delete order {id}: only DRAFT orders can be deleted"

  @happy_path
  Scenario: View order status history
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in SUBMITTED status with one item
    When I click Show history on the order
    Then the history panel should display status entries with timestamps

  @edge_case
  Scenario: Change order status via API from SUBMITTED to DRAFT
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in SUBMITTED status with one item
    When I send a PATCH request to change the order status to DRAFT via API
    Then the API response status should be 409
    And the API response body should contain message "Cannot transition order {id} from SUBMITTED to DRAFT"
