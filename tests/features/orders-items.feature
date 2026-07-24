Feature: Order Items Management

  @happy_path @orders_items
  Scenario: Delete DRAFT order
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in DRAFT status with one item
    When I open the orders page
    And I delete the order test order via the UI
    Then the order test order should no longer appear in the orders list
    And the order test order should not exist in the database

  @happy_path @orders_items
  Scenario: Edit DRAFT order items
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in DRAFT status with one item
    When I open the orders page
    And I edit the order test order and change the quantity to 5
    Then the order test order item quantity should be 5 in the database

  @edge_case @orders_items
  Scenario: Edit SUBMITTED order items via API
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in DRAFT status with one item
    And the order test order is submitted
    When I send a PATCH request to update items on the order test order
    Then the response status should be 409
    And the response body should mention "only DRAFT orders"

  @happy_path @orders_items
  Scenario: Order unitPrice snapshot
    Given an order test customer exists
    And an order test product exists with price 29.99
    And an order test order exists in DRAFT status with one item
    When the order test product price is updated to 49.99
    Then the order test order item unitPrice in the database should still be 29.99

  @happy_path @orders_items
  Scenario: Add multiple items to order
    Given an order test customer exists
    And an order test product exists with price 29.99
    And a second order test product exists with price 10.15
    When I open the orders page
    And I create an order test order with both order test products via the UI
    Then the order test order should contain 2 items in the database
