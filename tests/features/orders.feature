Feature: orders

  # Order status transitions, Kafka events, and deletion rules

  @happy_path @orders
  Scenario: Submit DRAFT order
    Given a customer exists for order testing
    And a product exists for order testing
    And a DRAFT order exists for that customer with that product
    When I submit the DRAFT order
    Then the order status should be "SUBMITTED" in the database
    And the order status history should contain "DRAFT" followed by "SUBMITTED"

  @happy_path @orders
  Scenario: Verify Kafka event on order creation
    Given the Kafka consumer is ready for order status events
    And a customer exists for order testing
    And a product exists for order testing
    When I create a new order for that customer with that product
    Then a Kafka message should be published with status "DRAFT" for the new order

  @happy_path @orders
  Scenario: Verify Kafka event on order submission
    Given the Kafka consumer is ready for order status events
    And a customer exists for order testing
    And a product exists for order testing
    And a DRAFT order exists for that customer with that product
    When I submit the DRAFT order
    Then a Kafka message should be published with status "SUBMITTED" for the order

  @happy_path @orders
  Scenario: Delete DRAFT order
    Given a customer exists for order testing
    And a product exists for order testing
    And a DRAFT order exists for that customer with that product
    When I delete the DRAFT order
    Then the order should no longer exist in the database

  @edge_case @orders
  Scenario: Attempt to delete SUBMITTED order
    Given a customer exists for order testing
    And a product exists for order testing
    And a SUBMITTED order exists for that customer with that product
    When I navigate to the orders page
    Then the order card for the SUBMITTED order should not have a Delete button

  @happy_path @orders
  Scenario: Edit DRAFT order items
    Given a customer exists for order editing tests
    And a product exists for order editing tests with price 15.00
    And a second product exists for order editing tests with price 25.00
    And a DRAFT order exists for the customer with the first product quantity 1
    When I update the order items to use the second product with quantity 3
    Then the order update response status should be 200
    And the order should have 1 item with productId of the second product and quantity 3
    And the order item unitPrice should be 25.00

  @edge_case @orders
  Scenario: Attempt to edit SUBMITTED order
    Given a customer exists for submitted order edit test
    And a product exists for submitted order edit test with price 10.00
    And a DRAFT order exists for the submitted order edit test customer
    And the order has been submitted
    When I attempt to update the submitted order items
    Then the order update response status should be 409 Conflict

  @happy_path @orders
  Scenario: Create order with quantity greater than 1
    Given a customer exists for quantity test
    And a product exists for quantity test with price 12.50
    When I create an order for the quantity test customer with the product quantity 5
    Then the order creation response status should be 201
    And the created order should have status "DRAFT"
    And the order item should have quantity 5 and unitPrice 12.50
    And the order item subtotal should be 62.50

  @edge_case @orders
  Scenario: API: Update order status with invalid status value
    Given a customer exists for invalid status test
    And a product exists for invalid status test with price 20.00
    And a DRAFT order exists for the invalid status test customer
    When I send a PATCH request to update the order status to "CANCELLED"
    Then the order status update response should be 400 with a validation error

  @happy_path @orders
  Scenario: Create Order with valid customer and items
    Given a customer exists for valid order creation
    And a product exists for valid order creation with price 29.99
    When I create an order for the valid order customer with the product quantity 2
    Then the order creation response status should be 201
    And the created order should have status "DRAFT"
    And the order should be saved in the database with status "DRAFT"
    And the OrderStatusHistory should have exactly 1 entry with status "DRAFT"

  # Order creation validation and multi-item scenarios

  @edge_case @orders
  Scenario: Create Order without selecting a customer
    Given I am on the orders page
    When I add an order item with product "Wireless Mouse" and quantity 1
    And I click the Create Order button without selecting a customer
    Then the order creation should fail with a customer required error

  @edge_case @orders
  Scenario: Create Order without any items
    Given I am on the orders page
    And there is an existing customer "Order Test Customer"
    When I select customer "Order Test Customer" for a new order
    And I click the Create Order button without adding any items
    Then the order creation should fail with items required error

  @happy_path @orders
  Scenario: Add multiple items to order
    Given I am on the orders page
    And there is an existing customer "Multi Item Customer"
    And there is an existing product "Multi Item Product A" with price 15.00
    And there is an existing product "Multi Item Product B" with price 25.50
    When I select customer "Multi Item Customer" for a new order
    And I add an order item with product "Multi Item Product A" and quantity 2
    And I click the add item button to add another item row
    And I add an order item with product "Multi Item Product B" and quantity 3
    And I click the Create Order button
    Then the order should be created successfully with status "DRAFT"
    And the order should have 2 items in the database
    And the order item for "Multi Item Product A" should have quantity 2 and unit price 15.00
    And the order item for "Multi Item Product B" should have quantity 3 and unit price 25.50

  @edge_case @orders
  Scenario: API: Create order with invalid customerId
    When I send a POST request to create an order with customerId 999999 and product id 1 quantity 1
    Then the order API response status should be 400 or 404 indicating invalid customer

  @edge_case @orders
  Scenario: API: Create order with invalid productId
    Given there is an existing customer for API order test
    When I send a POST request to create an order with a valid customer and invalid productId 999999
    Then the order API response status should be 400 or 404 indicating invalid product
