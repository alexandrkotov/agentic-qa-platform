Feature: orders-3

  @edge_case @orders-3
  Scenario: Create Order without selecting a customer
    # TODO (unconfirmed): Exact error message text and whether it appears as alert role or other element unknown
    Given an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Test Product {{unique}}",
          "price": 15.99
        }
      }
      """
    And a UI action is performed for "orders-3":
      """
      {
        "role": "link",
        "label": "Orders",
        "route": "/orders",
        "value": null,
        "scope": null
      }
      """
    When a UI action is performed for "orders-3":
      """
      {
        "role": "button",
        "label": "Create Order",
        "route": null,
        "value": null,
        "scope": null
      }
      """
    Then the "orders-3" UI element has this visibility:
      """
      {
        "role": "alert",
        "label": "Customer is required",
        "visible": true,
        "scope": null
      }
      """

  @edge_case @orders-3
  Scenario: Create Order without any items
    # TODO (unconfirmed): Exact error message text and whether it appears as alert role or other element unknown
    Given an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "order-no-items-{{unique}}@example.com",
          "name": "Order No Items Customer"
        }
      }
      """
    And a UI action is performed for "orders-3":
      """
      {
        "role": "link",
        "label": "Orders",
        "route": "/orders",
        "value": null,
        "scope": null
      }
      """
    And a UI action is performed for "orders-3":
      """
      {
        "role": "combobox",
        "label": "Customer",
        "route": null,
        "value": "Order No Items Customer",
        "scope": null
      }
      """
    When a UI action is performed for "orders-3":
      """
      {
        "role": "button",
        "label": "Create Order",
        "route": null,
        "value": null,
        "scope": null
      }
      """
    Then the "orders-3" UI element has this visibility:
      """
      {
        "role": "alert",
        "label": "At least one item is required",
        "visible": true,
        "scope": null
      }
      """

  @happy_path @orders-3
  Scenario: Add multiple items to order
    Given an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "multi-item-{{unique}}@example.com",
          "name": "Multi Item Customer"
        }
      }
      """
    And an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Product A {{unique}}",
          "price": 10
        }
      }
      """
    And an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Product B {{unique}}",
          "price": 20
        }
      }
      """
    When an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": "{products[0].id}",
              "quantity": 2
            },
            {
              "productId": "{products[1].id}",
              "quantity": 1
            }
          ]
        }
      }
      """
    Then the "orders-3" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And the "orders-3" response body has this field:
      """
      {
        "field": "status",
        "expected": "DRAFT"
      }
      """
    And the database has this row for "orders-3":
      """
      {
        "table": "OrderItem",
        "where": {
          "orderId": "{orders.id}",
          "productId": "{products[0].id}"
        },
        "expectedFields": {
          "quantity": 2,
          "unitPrice": "10.00"
        }
      }
      """
    And the database has this row for "orders-3":
      """
      {
        "table": "OrderItem",
        "where": {
          "orderId": "{orders.id}",
          "productId": "{products[1].id}"
        },
        "expectedFields": {
          "quantity": 1,
          "unitPrice": "20.00"
        }
      }
      """

  @edge_case @orders-3
  Scenario: API: Create order with invalid customerId
    # TODO (unconfirmed): Exact status code could be 400 or 404 depending on implementation - report does not specify
    Given an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Product Invalid Customer {{unique}}",
          "price": 25
        }
      }
      """
    When an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": 999999,
          "items": [
            {
              "productId": "{products.id}",
              "quantity": 1
            }
          ]
        }
      }
      """
    Then the "orders-3" response has this status code:
      """
      {
        "statusCode": 404
      }
      """

  @edge_case @orders-3
  Scenario: API: Create order with invalid productId
    # TODO (unconfirmed): Exact status code could be 400 or 404 depending on implementation - report does not specify
    Given an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "invalid-product-{{unique}}@example.com",
          "name": "Invalid Product Customer"
        }
      }
      """
    When an API request is sent for "orders-3":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": 999999,
              "quantity": 1
            }
          ]
        }
      }
      """
    Then the "orders-3" response has this status code:
      """
      {
        "statusCode": 404
      }
      """
