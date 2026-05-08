% Scalar complex libm-style builtins: sqrt / exp / log / log2 / log10 /
% expm1 / log1p / sin / cos / tan / asin / acos / atan / sinh / cosh /
% tanh — each dispatched to a complex implementation when the input is
% complex.
z = 1 + 2i;
disp(sqrt(z));
disp(exp(z));
disp(log(z));
disp(log2(z));
disp(log10(z));
disp(expm1(z));
disp(log1p(z));
disp(sin(z));
disp(cos(z));
disp(tan(z));
disp(asin(z));
disp(acos(z));
disp(atan(z));
disp(sinh(z));
disp(cosh(z));
disp(tanh(z));

% Real input still takes the libm-real path.
disp(sqrt(4));
disp(exp(0));
disp(log(2));
