% Cross-runner coverage for the `complex(...)` builtin. Numbl semantics:
%   complex(a)    - 1-arg form; promotes real to complex (imag=0).
%                   Complex input passes through unchanged.
%   complex(a, b) - 2-arg form; builds a + b*i. Rejects complex args.
% Scalar and tensor (including broadcast) inputs both supported.

% Scalar 1-arg: real promotion.
disp(complex(3));
disp(complex(-2.5));
disp(complex(0));

% Scalar 1-arg: complex passthrough.
disp(complex(1 + 2i));
disp(complex(0 + 0i));

% Scalar 2-arg.
disp(complex(1, 2));
disp(complex(-1.5, 2.5));
disp(complex(0, 0));

% Tensor 1-arg: real promotion.
disp(complex([1 2 3]));
disp(complex([1 2; 3 4]));

% Tensor 1-arg: complex passthrough (same data, same type).
disp(complex([1+1i, 2+2i]));

% Tensor 2-arg: same-shape pair.
disp(complex([1 2 3], [4 5 6]));
disp(complex([1 2; 3 4], [5 6; 7 8]));

% Tensor 2-arg: scalar broadcast (scalar + tensor, tensor + scalar).
disp(complex([1 2 3], 7));
disp(complex(7, [1 2 3]));

% Composition with constructors — the canonical idiom for a
% "complex zeros" tensor.
disp(complex(zeros(2)));
disp(complex(ones(2, 3)));
disp(complex(eye(3)));

% complex(re, im) with real-then-tensor / tensor-then-real arg shapes.
a = [1 2 3];
b = [4 5 6];
disp(complex(a, b));

% Variables threaded through subsequent arithmetic.
z = complex([1 2], [3 4]);
disp(z + 1);
disp(z * 2);
