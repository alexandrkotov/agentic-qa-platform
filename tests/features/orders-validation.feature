Feature: Orders validation
  As an API consumer
  I want order creation and status update endpoints to validate input correctly
  So that only well-formed orders and status transitions are accepted

  Background:
    Given an order test customer exists
    And an order test product exists with price 29.99

  @happy_path @orders_validation
  Scenario: Create order with valid customer and items
    When I create an order test order with valid customerId and items
    Then the order test response status should be 201
    And the created order should have status "DRAFT"
    And the OrderStatusHistory for the order should have exactly 1 entry with status "DRAFT"

  @edge_case @orders_validation
  Scenario: Create order without selecting customer
    When I create an order test order without a customerId
    Then the order test response status should indicate a validation error

  @edge_case @orders_validation
  Scenario: Create order without selecting product
    When I create an order test order with an empty items array
    Then the order test response status should indicate a validation error

  @edge_case @orders_validation
  Scenario: Create order with quantity zero
    When I create an order test order with item quantity 0
    Then the order test response should reflect current behavior for quantity zero

  @edge_case @orders_validation
  Scenario: Create order with negative quantity
    When I create an order test order with item quantity -1
    Then the order test response status should indicate a validation error

  @edge_case @orders_validation
  Scenario: Create order with non-existent customerId
    When I create an order test order with a non-existent customerId
    Then the order test response status should indicate a validation error

  @edge_case @orders_validation
  Scenario: Create order with non-existent productId
    When I create an order test order with a non-existent productId
    Then the order test response status should indicate a validation error

  @edge_case @orders_validation
  Scenario: Invalid order ID in API
    When I request GET on a non-existent order test order ID
    Then the order test response status should be 404
    When I request DELETE on a non-existent order test order ID
    Then the order test response status should be 404
    When I request PATCH status on a non-existent order test order ID
    Then the order test response status should be 404

  @edge_case @orders_validation
  Scenario: Invalid status value in order status update
    When I create an order test order with valid customerId and items
    And I update the order test order status with an invalid enum value
    Then the order test response status should indicate a validation error
